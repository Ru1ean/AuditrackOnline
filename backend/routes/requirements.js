const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const requirementsController = require('../controllers/RequirementsController');
const { auth, restrictAuditor } = require('../middleware/auth');
const { recordLog } = require('../controllers/logsController');
const { notifyUsers } = require('../utils/notify');
const {
    MAX_ACTIVE_EVIDENCE_PER_PERSONNEL,
    ensureEvidenceSchema,
    syncInitialVersionIfMissing,
    getActiveUploadCount,
    calculateStandardCompliance,
    syncStandardComplianceStatus,
    getDocumentHistory
} = require('../utils/evidenceService');

let reviewColumnsEnsured = false;
const ensureReviewColumns = async (db) => {
    if (reviewColumnsEnsured) return;
    try {
        await db.query('ALTER TABLE officeproofdocuments ADD COLUMN IF NOT EXISTS reviewstatus VARCHAR(20) DEFAULT \'pending\'');
        await db.query('ALTER TABLE officeproofdocuments ADD COLUMN IF NOT EXISTS rejectionreason TEXT DEFAULT NULL');
        await db.query('ALTER TABLE officeproofdocuments ADD COLUMN IF NOT EXISTS reviewedby INT DEFAULT NULL');
        await db.query('ALTER TABLE officeproofdocuments ADD COLUMN IF NOT EXISTS reviewedat TIMESTAMP DEFAULT NULL');
        await db.query('ALTER TABLE officeproofdocuments ADD COLUMN IF NOT EXISTS sortorder INT DEFAULT 0');
        reviewColumnsEnsured = true;
    } catch (e) {
        // Ignored if already exist
    }
};

// Get all uploaded files for a user and requirement (scoped by officeid if provided)
router.get('/:requirementid/user-file/:userid', auth, async (req, res) => {
    try {
        const db = require('../db');
        const { requirementid, userid } = req.params;
        const officeid = req.query.officeid ? Number(req.query.officeid) : null;

        let rows = [];
        let whereClause = 'WHERE opd.requirementid = ? AND opd.uploadedby = ?';
        let queryParams = [requirementid, userid];

        if (officeid) {
            whereClause += ' AND opd.officeid = ?';
            queryParams.push(officeid);
        }

        if (req.user && Number(req.user.roleid) === 4) {
            whereClause += " AND opd.reviewstatus = 'approved'";
        }

        try {
            const [r] = await db.query(
                `SELECT opd.id, opd.filename, opd.displayname, opd.comment, opd.filepath, opd.uploadedat, opd.sortorder, opd.uploadedby, opd.officeid,
                        opd.reviewstatus, opd.rejectionreason, opd.reviewedby, opd.reviewedat, opd.currentversion,
                        u.firstname as reviewer_first_name, u.lastname as reviewer_last_name
                 FROM officeproofdocuments opd
                 LEFT JOIN users u ON opd.reviewedby = u.userid
                 ${whereClause} 
                 ORDER BY opd.sortorder ASC, opd.id ASC`,
                queryParams
            );
            rows = r;
        } catch (e) {
            await ensureReviewColumns(db);
            const [r] = await db.query(
                `SELECT opd.id, opd.filename, opd.displayname, opd.comment, opd.filepath, opd.uploadedat, opd.sortorder, opd.uploadedby, opd.officeid,
                        opd.reviewstatus, opd.rejectionreason, opd.reviewedby, opd.reviewedat, opd.currentversion,
                        u.firstname as reviewer_first_name, u.lastname as reviewer_last_name
                 FROM officeproofdocuments opd
                 LEFT JOIN users u ON opd.reviewedby = u.userid
                 ${whereClause} 
                 ORDER BY opd.sortorder ASC, opd.id ASC`,
                queryParams
            );
            rows = r;
        }

        if (!rows || rows.length === 0) {
            return res.json({ success: true, message: 'No files found for this user and requirement', files: [], file: null });
        }

        const files = rows.map(file => {
            let fileUrl = file.filepath || '';
            if (fileUrl.startsWith('/uploads/documents/')) {
                fileUrl = fileUrl.replace('/uploads/documents/', '/uploads/events/');
            }
            const revFirstName = file.reviewer_first_name || '';
            const revLastName = file.reviewer_last_name || '';
            const reviewerName = (revFirstName || revLastName) ? `${revFirstName} ${revLastName}`.trim() : null;

            return {
                id: file.id,
                filename: file.filename,
                displayname: file.displayname || file.filename,
                comment: (req.user && (req.user.roleid === 4 || Number(req.user.roleid) === 4)) ? '' : (file.comment || ''),
                url: fileUrl.startsWith('http') ? fileUrl : `http://localhost:${process.env.PORT || 5200}${fileUrl}`,
                uploadedat: file.uploadedat,
                sortorder: file.sortorder ?? 0,
                reviewstatus: file.reviewstatus || 'pending',
                rejectionreason: (req.user && (req.user.roleid === 4 || Number(req.user.roleid) === 4)) ? '' : (file.rejectionreason || ''),
                reviewedby: file.reviewedby || null,
                reviewedat: file.reviewedat || null,
                reviewerName: reviewerName,
                currentversion: Number(file.currentversion || 1),
                uploadedby: file.uploadedby,
                userid: file.uploadedby,
                officeid: file.officeid
            };
        });

        const [compliance, activeUploadCount] = await Promise.all([
            calculateStandardCompliance(db, requirementid, officeid),
            getActiveUploadCount(db, requirementid, userid, officeid)
        ]);

        res.json({
            success: true,
            files: files,
            file: files.length > 0 ? files[files.length - 1] : null,
            activeUploadCount,
            maxUploadLimit: MAX_ACTIVE_EVIDENCE_PER_PERSONNEL,
            compliance
        });
    } catch (error) {
        console.error('Error fetching user files:', error);
        res.status(500).json({ success: false, message: 'Error fetching user files', error: error.message });
    }
});

// Reorder evidence files order for a user and requirement
router.patch('/:requirementid/user-file/:userid/reorder', auth, async (req, res) => {
    try {
        const db = require('../db');
        const { requirementid, userid } = req.params;
        const { orderedIds } = req.body;

        if (!Array.isArray(orderedIds)) {
            return res.status(400).json({ success: false, message: 'orderedIds array is required' });
        }

        await ensureReviewColumns(db);

        for (let i = 0; i < orderedIds.length; i++) {
            await db.query(
                'UPDATE officeproofdocuments SET sortorder = ? WHERE id = ?',
                [i, orderedIds[i]]
            );
        }

        const { emitDataChange } = require('../socket');
        emitDataChange('requirements', { action: 'reorder', requirementid, userid, orderedIds });

        res.json({ success: true, message: 'Files reordered successfully' });
    } catch (error) {
        console.error('Error reordering user files:', error);
        res.status(500).json({ success: false, message: 'Error reordering files', error: error.message });
    }
});

// Rename custom display title for an evidence file
router.patch('/:requirementid/file/:fileId/rename', auth, async (req, res) => {
    try {
        const db = require('../db');
        const { fileId } = req.params;
        const displayname = req.body.displayname || req.body.displayName;
        if (!displayname || !String(displayname).trim()) {
            return res.status(400).json({ success: false, message: 'Display name is required' });
        }

        let trimmedTitle = displayname.trim();
        // Remove trailing file extension from custom title if present
        const dotIdx = trimmedTitle.lastIndexOf('.');
        if (dotIdx > 0 && dotIdx >= trimmedTitle.length - 6) {
            trimmedTitle = trimmedTitle.substring(0, dotIdx).trim() || trimmedTitle;
        }

        // 1. Get current document row
        const [rows] = await db.query(
            'SELECT id, filename, displayname, filepath, uploadedby FROM officeproofdocuments WHERE id = ? LIMIT 1',
            [fileId]
        );

        if (!rows || rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Document not found' });
        }

        const doc = rows[0];

        // Authorization: allow admins, or auditors only for their own uploaded files
        const actorRole = Number(req.user?.roleid || 0);
        const actorId = Number(req.user?.userid || 0);
        if (actorRole === 4 && Number(doc.uploadedby) !== actorId) {
            return res.status(403).json({ success: false, message: 'Forbidden: auditors may only rename their own files' });
        }

        // 2. Update DB with new custom display title
        await db.query(
            'UPDATE officeproofdocuments SET displayname = ? WHERE id = ?',
            [trimmedTitle, fileId]
        );

        res.json({
            success: true,
            message: 'Document renamed successfully',
            displayname: trimmedTitle,
            filename: doc.filename,
            filepath: doc.filepath,
            url: doc.filepath
        });
    } catch (error) {
        console.error('Error renaming evidence document:', error);
        res.status(500).json({ success: false, message: 'Error renaming document', error: error.message });
    }
});

// Update comment for an evidence file
router.patch('/:requirementid/file/:fileId/comment', auth, async (req, res) => {
    try {
        const db = require('../db');
        const { fileId } = req.params;
        const { comment } = req.body;
        const trimmedComment = comment ? comment.trim() : '';

        await ensureReviewColumns(db);

        // Fetch file uploader and metadata
        const [fileRows] = await db.query(
            `SELECT opd.uploadedby, opd.displayname, opd.officeid, opd.requirementid, opd.reviewstatus, r.requirementcode, o.officename
             FROM officeproofdocuments opd
             LEFT JOIN requirements r ON opd.requirementid = r.requirementid
             LEFT JOIN offices o ON opd.officeid = o.officeid
             WHERE opd.id = ? LIMIT 1`,
            [fileId]
        );

        await db.query(
            'UPDATE officeproofdocuments SET comment = ?, rejectionreason = CASE WHEN reviewstatus = \'rejected\' THEN ? ELSE rejectionreason END WHERE id = ?',
            [trimmedComment, trimmedComment, fileId]
        );

        if (fileRows && fileRows.length > 0) {
            const fileDoc = fileRows[0];
            const uploaderId = Number(fileDoc.uploadedby);
            const actorId = Number(req.user?.userid || 0);

            const recipients = [];

            // 1. Notify the file uploader if they are not the one commenting
            if (uploaderId && uploaderId !== actorId) {
                recipients.push(uploaderId);
            }

            try {
                const { createNotifications, getAdminUserIds } = require('../utils/notificationService');
                const adminIds = await getAdminUserIds();

                // 2. Get auditors assigned to this office
                const [auditorRows] = await db.query(
                    `SELECT aaa.auditoruserid as userid
                     FROM auditorareaassignments aaa
                     JOIN offices o ON o.officeid = ?
                     JOIN criteria c ON c.eventid = o.eventid
                     WHERE aaa.areaid = c.areaid`,
                    [fileDoc.officeid]
                );
                const auditorUserIds = auditorRows.map(r => Number(r.userid));

                // Merge admins and auditors, excluding the commenter
                const others = [...adminIds, ...auditorUserIds].filter(id => id !== actorId);
                recipients.push(...others);

                const uniqueRecipients = [...new Set(recipients)];

                if (uniqueRecipients.length > 0) {
                    const reqCode = fileDoc.requirementcode || 'a requirement';
                    const officename = fileDoc.officename || 'your office';

                    await createNotifications({
                        userIds: uniqueRecipients,
                        adminid: actorId,
                        title: 'New Comment on Uploaded File',
                        message: `A new comment was added to the uploaded file "${fileDoc.displayname}" for requirement ${reqCode} in ${officename}.`,
                        type: 'info',
                        relatedtable: 'requirement_file_comment',
                        relatedid: Number(fileDoc.officeid),
                        meta: {
                            officeid: Number(fileDoc.officeid),
                            requirementid: Number(fileDoc.requirementid),
                            openSubmission: true
                        }
                    });
                }
            } catch (notifErr) {
                console.error('Failed to notify about comment:', notifErr);
            }
        }

        try {
            const { emitDataChange } = require('../socket');
            emitDataChange('requirements', {
                action: 'comment',
                requirementid: Number(req.params.requirementid),
                fileId: Number(fileId),
                comment: trimmedComment
            });
        } catch (sErr) { }

        res.json({ success: true, message: 'Document comment updated successfully', comment: trimmedComment });
    } catch (error) {
        console.error('Error updating evidence document comment:', error);
        res.status(500).json({ success: false, message: 'Error updating document comment', error: error.message });
    }
});

// Update review status (Approved, Rejected, Pending) for an evidence file
router.patch('/:requirementid/file/:fileId/review', auth, async (req, res) => {
    try {
        const db = require('../db');
        const { fileId } = req.params;
        const { status, reason } = req.body;
        const actorRole = Number(req.user?.roleid || 0);
        const actorId = Number(req.user?.userid || 0);

        // Role check: Only Admin (1) can approve or reject evidence
        if (actorRole !== 1) {
            return res.status(403).json({ success: false, message: 'Unauthorized: Only Admins can approve or reject evidence files' });
        }

        if (!['approved', 'rejected', 'pending'].includes(status)) {
            return res.status(400).json({ success: false, message: 'Invalid review status. Must be approved, rejected, or pending' });
        }

        await ensureReviewColumns(db);
        await ensureEvidenceSchema(db);

        // Fetch file and requirement metadata
        const [fileRows] = await db.query(
            `SELECT opd.*,
                    r.requirementcode, o.officename
             FROM officeproofdocuments opd
             LEFT JOIN requirements r ON opd.requirementid = r.requirementid
             LEFT JOIN offices o ON opd.officeid = o.officeid
             WHERE opd.id = ? LIMIT 1`,
            [fileId]
        );

        if (!fileRows || fileRows.length === 0) {
            return res.status(404).json({ success: false, message: 'Evidence document not found' });
        }

        const fileDoc = fileRows[0];
        const existingComment = fileDoc.comment || '';
        const trimmedReason = reason !== undefined ? (reason ? reason.trim() : '') : existingComment;

        if (status === 'rejected' && !trimmedReason) {
            return res.status(400).json({
                success: false,
                message: 'A rejection reason or feedback is required when rejecting evidence.'
            });
        }

        const reviewedby = status === 'pending' ? null : actorId;
        const reviewedat = status === 'pending' ? null : new Date();
        const currentVer = Number(fileDoc.currentversion || 1);

        await db.withTransaction(async (tx) => {
            await syncInitialVersionIfMissing(tx, fileDoc);

            if (status === 'pending') {
                await tx.query(
                    `UPDATE officeproofdocuments 
                     SET reviewstatus = 'pending', rejectionreason = NULL, reviewedby = NULL, reviewedat = NULL 
                     WHERE id = ?`,
                    [fileId]
                );
                await tx.query(
                    `UPDATE officeproofdocumentversions
                     SET reviewstatus = 'pending', rejectionreason = NULL, reviewedby = NULL, reviewedat = NULL
                     WHERE documentid = ? AND versionno = ?`,
                    [fileId, currentVer]
                );
            } else {
                await tx.query(
                    `UPDATE officeproofdocuments 
                     SET reviewstatus = ?, 
                         rejectionreason = ?, 
                         comment = CASE WHEN ? != '' THEN ? ELSE comment END,
                         reviewedby = ?, 
                         reviewedat = CURRENT_TIMESTAMP 
                     WHERE id = ?`,
                    [status, status === 'rejected' ? trimmedReason : null, trimmedReason, trimmedReason, actorId, fileId]
                );
                await tx.query(
                    `UPDATE officeproofdocumentversions
                     SET reviewstatus = ?,
                         rejectionreason = ?,
                         comment = CASE WHEN ? != '' THEN ? ELSE comment END,
                         reviewedby = ?,
                         reviewedat = CURRENT_TIMESTAMP
                     WHERE documentid = ? AND versionno = ?`,
                    [status, status === 'rejected' ? trimmedReason : null, trimmedReason, trimmedReason, actorId, fileId, currentVer]
                );
            }
        });

        const compliance = await calculateStandardCompliance(db, fileDoc.requirementid, fileDoc.officeid);
        await syncStandardComplianceStatus(db, fileDoc.requirementid, fileDoc.officeid, compliance);

        // Fetch reviewer name
        const [reviewerRows] = await db.query('SELECT firstname, lastname FROM users WHERE userid = ? LIMIT 1', [actorId]);
        const reviewerName = reviewerRows && reviewerRows.length > 0
            ? `${reviewerRows[0].firstname || ''} ${reviewerRows[0].lastname || ''}`.trim()
            : 'Auditor';

        // Notify uploader if reviewer is not the uploader
        const uploaderId = Number(fileDoc.uploadedby);
        if (uploaderId && uploaderId !== actorId) {
            try {
                const { createNotifications } = require('../utils/notificationService');
                const reqCode = fileDoc.requirementcode || 'a requirement';
                const fileTitle = fileDoc.displayname || fileDoc.filename || 'evidence document';

                const statusTitle = status === 'approved'
                    ? 'Evidence Approved'
                    : status === 'rejected'
                        ? 'Evidence Rejected - Action Required'
                        : 'Evidence Review Reset';

                const statusMessage = status === 'approved'
                    ? `Your evidence "${fileTitle}" for ${reqCode} has been approved.`
                    : status === 'rejected'
                        ? `Your evidence "${fileTitle}" for ${reqCode} was rejected. Note: ${trimmedReason || 'Needs revision'}`
                        : `Your evidence "${fileTitle}" for ${reqCode} review status was reset to pending.`;

                await createNotifications({
                    userIds: [uploaderId],
                    adminid: actorId,
                    title: statusTitle,
                    message: statusMessage,
                    type: status === 'approved' ? 'success' : status === 'rejected' ? 'warning' : 'info',
                    relatedtable: 'requirement_file_review',
                    relatedid: Number(fileDoc.officeid),
                    meta: {
                        officeid: Number(fileDoc.officeid),
                        requirementid: Number(fileDoc.requirementid),
                        openSubmission: true
                    }
                });
            } catch (notifErr) {
                console.error('Failed to notify uploader of review status:', notifErr);
            }
        }

        try {
            const { emitDataChange } = require('../socket');
            emitDataChange('requirements', {
                action: 'review',
                requirementid: Number(req.params.requirementid),
                fileId: Number(fileId),
                userid: uploaderId,
                reviewstatus: status,
                comment: trimmedReason || existingComment,
                rejectionreason: status === 'rejected' ? trimmedReason : '',
                reviewedby: reviewedby,
                reviewedat: reviewedat,
                reviewerName: reviewerName,
                compliance
            });
        } catch (sErr) { }

        res.json({
            success: true,
            message: `Evidence marked as ${status}`,
            reviewstatus: status,
            comment: trimmedReason || existingComment,
            rejectionreason: status === 'rejected' ? trimmedReason : '',
            reviewedby: reviewedby,
            reviewedat: reviewedat,
            reviewerName: reviewerName,
            compliance
        });
    } catch (error) {
        console.error('Error updating evidence review status:', error);
        res.status(500).json({ success: false, message: 'Error updating review status', error: error.message });
    }
});

// Delete uploaded file for a user and requirement (unsubmit specific file or latest, scoped to officeid)
router.delete('/:requirementid/file/:userid', auth, async (req, res) => {
    try {
        const db = require('../db');
        const { requirementid, userid } = req.params;
        const targetFileId = req.query.fileId ? Number(req.query.fileId) : null;
        const officeid = req.query.officeid ? Number(req.query.officeid) : null;

        // Authorization: auditors may only delete their own files
        const actorRole = Number(req.user?.roleid || 0);
        const actorId = Number(req.user?.userid || 0);
        if (actorRole === 4 && actorId !== Number(userid)) {
            return res.status(403).json({ success: false, message: 'Forbidden: auditors may only delete their own files' });
        }

        let rows = [];
        if (targetFileId) {
            let q = 'SELECT id, officeid, filename, displayname, filepath FROM officeproofdocuments WHERE id = ? AND requirementid = ? AND uploadedby = ?';
            let p = [targetFileId, requirementid, userid];
            if (officeid) {
                q += ' AND officeid = ?';
                p.push(officeid);
            }
            q += ' LIMIT 1';
            [rows] = await db.query(q, p);
        } else {
            let q = 'SELECT id, officeid, filename, displayname, filepath FROM officeproofdocuments WHERE requirementid = ? AND uploadedby = ?';
            let p = [requirementid, userid];
            if (officeid) {
                q += ' AND officeid = ?';
                p.push(officeid);
            }
            q += ' ORDER BY uploadedat DESC LIMIT 1';
            [rows] = await db.query(q, p);
        }

        if (!rows || rows.length === 0) {
            return res.status(404).json({ success: false, message: 'No uploaded file found for this user and requirement' });
        }

        const file = rows[0];
        const resolvedFileOfficeId = file.officeid || officeid || null;

        const filepath = file.filepath || file.filepath || file.filename;
        const absPath = path.join(__dirname, '..', filepath.replace(/^\//, ''));

        // Delete from DB
        await db.query(
            'DELETE FROM officeproofdocuments WHERE id = ?',
            [file.id]
        );

        // Delete from Supabase Storage bucket (if hosted on cloud)
        try {
            const { deleteFromSupabaseBucket } = require('../utils/supabaseStorage');
            await deleteFromSupabaseBucket(filepath, 'proof-documents');
        } catch (sErr) {
            console.warn('Supabase Storage file deletion warning:', sErr);
        }

        // Check if other DB records use the same physical file on disk
        const [sharedRows] = await db.query(
            'SELECT id FROM officeproofdocuments WHERE filepath = ? LIMIT 1',
            [file.filepath]
        );
        if (!sharedRows || sharedRows.length === 0) {
            try {
                if (fs.existsSync(absPath)) {
                    fs.unlinkSync(absPath);
                }
            } catch (fsErr) {
                console.warn('Failed to delete file from disk:', fsErr);
            }
        }

        try {
            const [[contextRow]] = await db.query(
                `SELECT
                    r.requirementcode,
                    r.Description AS RequirementDescription,
                    o.officename,
                    e.eventname
                 FROM requirements r
                 LEFT JOIN criteria c ON c.criteriaid = r.criteriaid
                 LEFT JOIN events e ON e.eventid = c.eventid
                 LEFT JOIN offices o ON o.officeid = ?
                 WHERE r.requirementid = ?
                 LIMIT 1`,
                [resolvedFileOfficeId, requirementid]
            );

            const actorUserId = Number(req.user?.userid || userid);
            if (Number.isInteger(actorUserId) && actorUserId > 0) {
                await recordLog(actorUserId, 'RequirementFileUnsubmitted', {
                    requirementid: Number(requirementid),
                    requirementcode: contextRow?.requirementcode || null,
                    RequirementDescription: contextRow?.RequirementDescription || null,
                    officename: contextRow?.officename || null,
                    eventname: contextRow?.eventname || null,
                    FileName: rows[0]?.filename || null,
                    UploadedByUserID: Number(userid),
                });
            }
        } catch (logErr) {
            console.error('Failed to record unsubmit upload log:', logErr);
        }

        // Check remaining uploaded files count for this user & requirement & office
        let countQ = 'SELECT COUNT(*) as cnt FROM officeproofdocuments WHERE requirementid = ? AND uploadedby = ?';
        let countP = [Number(requirementid), Number(userid)];
        if (resolvedFileOfficeId) {
            countQ += ' AND officeid = ?';
            countP.push(Number(resolvedFileOfficeId));
        }
        const [remaining] = await db.query(countQ, countP);

        const remainingCount = Number(remaining[0]?.cnt ?? 0);
        if (remainingCount === 0) {
            try {
                if (resolvedFileOfficeId) {
                    await db.query(
                        'UPDATE requirementuserassignments SET hasuploaded = FALSE WHERE requirementid = ? AND userid = ? AND (officeid = ? OR officeid IS NULL)',
                        [Number(requirementid), Number(userid), Number(resolvedFileOfficeId)]
                    );
                } else {
                    await db.query(
                        'UPDATE requirementuserassignments SET hasuploaded = FALSE WHERE requirementid = ? AND userid = ?',
                        [Number(requirementid), Number(userid)]
                    );
                }
            } catch (uErr) {
                console.warn('Failed to update requirementuserassignments hasuploaded flag:', uErr);
            }
        }

        const syncedCompliance = await syncStandardComplianceStatus(db, requirementid, resolvedFileOfficeId);

        try {
            const { emitDataChange } = require('../socket');
            emitDataChange('requirements', { action: 'unsubmit', requirementid, userid, officeid: resolvedFileOfficeId, fileId: file.id, compliance: syncedCompliance });
        } catch (sockErr) {
            // ignore
        }

        res.json({ success: true, message: 'Uploaded file deleted successfully', remainingCount, compliance: syncedCompliance });
    } catch (error) {
        console.error('Error deleting user uploaded file:', error);
        res.status(500).json({ success: false, message: 'Error deleting uploaded file', error: error.message });
    }
});

// Multer config for user requirement uploads (sync, temp folder)
const tempUserReqUploadDir = path.join(__dirname, '../uploads/tmp-user-uploads');
if (!fs.existsSync(tempUserReqUploadDir)) {
    fs.mkdirSync(tempUserReqUploadDir, { recursive: true });
}
const userReqUpload = multer({
    dest: tempUserReqUploadDir,
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|pdf|doc|docx|xls|xlsx|mp4|webm|ogg|mov|avi|mkv/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        if (extname) {
            return cb(null, true);
        }
        cb(new Error('Only images, videos, PDFs, and Office documents are allowed'));
    }
});

// Requirements routes
router.get('/all', auth, requirementsController.getAllRequirements);
router.get('/event/:eventid', auth, requirementsController.getRequirementsByEvent);
router.get('/criteria/:criteriaid', auth, requirementsController.getRequirementsByCriteria);
router.post('/add', auth, requirementsController.addRequirement);
// Update compliance evaluation status for a requirement
router.put('/:requirementid/status', auth, async (req, res) => {
    try {
        const db = require('../db');
        const { requirementid } = req.params;
        const { statusId, statusid, comments } = req.body;
        const nextStatusId = Number(statusId || statusid);
        const officeId = req.body.officeId || req.body.officeid;

        if (!nextStatusId || ![3, 4, 5].includes(nextStatusId)) {
            return res.status(400).json({ success: false, message: 'Invalid status. Must be 3, 4, or 5' });
        }

        let targetOfficeId = officeId ? Number(officeId) : null;
        if (!targetOfficeId) {
            const [csoRow] = await db.query('SELECT officeid FROM compliancestatusoffices WHERE requirementid = ? LIMIT 1', [requirementid]);
            if (csoRow && csoRow.length > 0) {
                targetOfficeId = Number(csoRow[0].officeid);
            } else {
                const [ruaRow] = await db.query('SELECT officeid FROM requirementuserassignments WHERE requirementid = ? LIMIT 1', [requirementid]);
                if (ruaRow && ruaRow.length > 0) {
                    targetOfficeId = Number(ruaRow[0].officeid);
                }
            }
        }

        if (targetOfficeId) {
            req.params.id = targetOfficeId;
            req.body.statusid = nextStatusId;
            const OfficesController = require('../controllers/OfficesController');
            return OfficesController.updateRequirementStatus(req, res);
        }

        return res.status(400).json({ success: false, message: 'Office not found for this requirement' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.put('/update/:id', auth, requirementsController.updateRequirement);
router.put('/:id', auth, requirementsController.updateRequirement);
router.post('/delete', auth, requirementsController.deleteRequirements);

// User assignment routes
router.post('/assign-users', auth, requirementsController.assignUsersToRequirement);
router.get('/assigned-users/:requirementid', auth, requirementsController.getAssignedUsers);
router.get('/my-assignments', auth, requirementsController.getMyAssignments);
router.delete('/assignment/:assignmentid', auth, requirementsController.removeUserAssignment);
router.get('/user-assignment-count/:userid', auth, requirementsController.getUserAssignmentCount);
router.get('/available-users', auth, requirementsController.getAvailableUsersForAssignment);
router.put('/assignment/:assignmentid/upload-status', auth, requirementsController.updateUserUploadStatus);
router.post('/mark-uploaded', auth, requirementsController.markUserAsUploaded);

// User requirement file upload route
router.post('/user-upload', auth, userReqUpload.single('file'), async (req, res) => {
    try {
        if (req.user && (req.user.roleid === 4 || Number(req.user.roleid) === 4)) {
            return res.status(403).json({ success: false, message: 'External Auditors are not permitted to upload evidence files.' });
        }
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No file uploaded' });
        }
        const requirementid = req.body.requirementid || req.body.requirementId;
        const userid = req.body.userid || req.body.userId;
        const displayname = req.body.displayname || req.body.displayName;
        const comment = req.body.comment;
        const officeid = req.body.officeid || req.body.officeId;
        if (!requirementid || !userid) {
            return res.status(400).json({ success: false, message: 'requirementid and userid are required' });
        }

        const db = require('../db');

        // Check max 40 active files (approved + pending) per user per requirement for this specific office
        // Rejected files do not occupy an upload slot.
        const resolvedOfficeId = officeid ? Number(officeid) : null;
        const currentFileCount = await getActiveUploadCount(db, requirementid, userid, resolvedOfficeId);
        if (currentFileCount >= MAX_ACTIVE_EVIDENCE_PER_PERSONNEL) {
            if (req.file && req.file.path && fs.existsSync(req.file.path)) {
                try { fs.unlinkSync(req.file.path); } catch (e) { }
            }
            return res.status(400).json({
                success: false,
                message: `Maximum limit of ${MAX_ACTIVE_EVIDENCE_PER_PERSONNEL} active uploaded files reached for this standard. Rejected files do not count toward this limit.`
            });
        }

        // Get requirement info for event and office
        const [rows] = await db.query(`
            SELECT r.requirementid, r.requirementcode, r.Description, 
                   COALESCE(c.eventid, a.eventid) AS eventid, 
                   e.eventname, e.eventcode, rua.officeid, 
                   c.criteriaid, c.parentcriteriaid, c.criterianame, c.criteriacode, 
                   a.areaid, a.areacode, a.areaname
            FROM requirements r
            LEFT JOIN criteria c ON r.criteriaid = c.criteriaid
            LEFT JOIN areas a ON c.areaid = a.areaid
            LEFT JOIN Events e ON COALESCE(c.eventid, a.eventid) = e.eventid
            LEFT JOIN requirementuserassignments rua ON rua.requirementid = r.requirementid AND rua.userid = ? ${resolvedOfficeId ? 'AND rua.officeid = ?' : ''}
            WHERE r.requirementid = ?
            LIMIT 1
        `, resolvedOfficeId ? [userid, resolvedOfficeId, requirementid] : [userid, requirementid]);

        if (!rows || rows.length === 0) {
            return res.status(400).json({ success: false, message: 'Requirement not found' });
        }

        const reqRow = rows[0];
        const eventname = reqRow.eventname || '';
        const eventcode = reqRow.eventcode || eventname || 'Event';
        const reqOfficeId = reqRow.officeid || null;
        const finalResolvedOfficeId = resolvedOfficeId || (reqOfficeId ? Number(reqOfficeId) : null);

        // Authorization check: Only assigned personnel and assigned auditors can upload evidence
        const actorUserId = Number(req.user?.userid || req.user?.userid || req.user?.id);
        const actorRoleId = Number(req.user?.roleid || req.user?.roleid || 0);
        const isAdmin = actorRoleId === 1;

        if (!isAdmin) {
            if (Number(userid) !== actorUserId) {
                if (req.file && req.file.path && fs.existsSync(req.file.path)) {
                    try { fs.unlinkSync(req.file.path); } catch (e) { }
                }
                return res.status(403).json({
                    success: false,
                    message: 'Forbidden: You can only upload files for your own account.'
                });
            }

            let isHeadAssigned = false;
            if (finalResolvedOfficeId) {
                try {
                    const [headRows] = await db.query(
                        `SELECT 1 FROM officeheadassignments oha 
                         JOIN headofoffice h ON oha.headid = h.headid 
                         WHERE oha.officeid = ? AND h.userid = ?`,
                        [finalResolvedOfficeId, actorUserId]
                    );
                    if (headRows && headRows.length > 0) isHeadAssigned = true;
                } catch (hErr) {
                    console.warn('Head assignment check error:', hErr.message);
                }
            }

            let isReqAssigned = false;
            try {
                const [reqAssignRows] = await db.query(
                    `SELECT 1 FROM requirementuserassignments 
                     WHERE requirementid = ? AND userid = ? ${finalResolvedOfficeId ? 'AND (officeid = ? OR officeid IS NULL)' : ''}`,
                    finalResolvedOfficeId ? [requirementid, actorUserId, finalResolvedOfficeId] : [requirementid, actorUserId]
                );
                if (reqAssignRows && reqAssignRows.length > 0) isReqAssigned = true;
            } catch (rErr) {
                console.warn('Requirement user assignment check error:', rErr.message);
            }

            let isAuditorAssigned = false;
            if (actorRoleId === 4) {
                const reqAreaId = Number(reqRow.areaid || 0);
                if (reqAreaId) {
                    try {
                        const [auditorAreaRows] = await db.query(
                            `SELECT 1 FROM auditorareaassignments 
                             WHERE areaid = ? AND auditoruserid = ?`,
                            [reqAreaId, actorUserId]
                        );
                        if (auditorAreaRows && auditorAreaRows.length > 0) isAuditorAssigned = true;
                    } catch (aaErr) {
                        console.warn('Auditor area check error:', aaErr.message);
                    }
                }
                if (!isAuditorAssigned && finalResolvedOfficeId) {
                    try {
                        const [auditorOfficeRows] = await db.query(
                            `SELECT 1 FROM auditorareaassignments aaa
                             JOIN offices o ON o.officeid = ?
                             JOIN criteria c ON c.eventid = o.eventid
                             WHERE aaa.areaid = c.areaid AND aaa.auditoruserid = ?`,
                            [finalResolvedOfficeId, actorUserId]
                        );
                        if (auditorOfficeRows && auditorOfficeRows.length > 0) isAuditorAssigned = true;
                    } catch (aoErr) {
                        console.warn('Auditor office check error:', aoErr.message);
                    }
                }
            }

            let isPersonnelAssigned = false;
            try {
                const reqEventId = Number(reqRow.eventid || 0);
                const reqAreaId = Number(reqRow.areaid || 0);
                const reqCritId = Number(reqRow.criteriaid || 0);
                const reqParentCritId = Number(reqRow.parentcriteriaid || 0);
                const reqId = Number(reqRow.requirementid || requirementid);

                const conditions = ['pa.userid = ?'];
                const paParams = [actorUserId];

                if (reqEventId) {
                    conditions.push('(pa.eventid = ? OR pa.eventid = 0 OR pa.eventid IS NULL)');
                    paParams.push(reqEventId);
                }

                const scopeConditions = [];
                if (reqId) {
                    scopeConditions.push('pa.requirementid = ?');
                    paParams.push(reqId);
                }
                if (reqCritId) {
                    scopeConditions.push('pa.criteriaid = ?');
                    paParams.push(reqCritId);
                }
                if (reqParentCritId) {
                    scopeConditions.push('pa.criteriaid = ?');
                    paParams.push(reqParentCritId);
                }
                if (reqAreaId) {
                    scopeConditions.push('pa.areaid = ?');
                    paParams.push(reqAreaId);
                }

                if (scopeConditions.length > 0) {
                    conditions.push(`(${scopeConditions.join(' OR ')})`);
                    const paQuery = `SELECT 1 FROM personnelassignments pa WHERE ${conditions.join(' AND ')} LIMIT 1`;
                    const [paRows] = await db.query(paQuery, paParams);
                    if (paRows && paRows.length > 0) isPersonnelAssigned = true;
                }
            } catch (paErr) {
                console.warn('Personnel assignment check error:', paErr.message);
            }

            if (!isHeadAssigned && !isReqAssigned && !isAuditorAssigned && !isPersonnelAssigned) {
                if (req.file && req.file.path && fs.existsSync(req.file.path)) {
                    try { fs.unlinkSync(req.file.path); } catch (e) { }
                }
                return res.status(403).json({
                    success: false,
                    message: 'Forbidden: You are not assigned to this standard, sub-area, area, or office.'
                });
            }
        }

        const Description = reqRow.Description || reqRow.description || '';
        const criterianame = reqRow.criterianame || reqRow.criterianame || '';
        const criteriacode = reqRow.criteriacode || reqRow.criteriacode || criterianame || '';
        const requirementcode = reqRow.requirementcode || reqRow.requirementcode || '';
        const areacode = reqRow.areacode || reqRow.areacode || '';
        const areaname = reqRow.areaname || reqRow.areaname || '';

        let officename = 'Office';
        if (finalResolvedOfficeId) {
            try {
                const [officeRows] = await db.query('SELECT officename FROM offices WHERE officeid = ?', [finalResolvedOfficeId]);
                if (officeRows && officeRows.length > 0) {
                    officename = officeRows[0].officename || officeRows[0].officename || 'Office';
                }
            } catch (oErr) {
                console.warn('Office lookup notice:', oErr.message);
            }
        }

        let userName = 'User';
        try {
            const [userRows] = await db.query('SELECT firstname, lastname FROM users WHERE userid = ?', [userid]);
            if (userRows && userRows.length > 0) {
                const fn = userRows[0].firstname || userRows[0].firstname || '';
                const ln = userRows[0].lastname || userRows[0].lastname || '';
                userName = `${fn}_${ln}`.trim() || 'User';
            }
        } catch (uErr) {
            console.warn('User lookup notice:', uErr.message);
        }

        const safeEventName = (eventcode || eventname || 'Event').replace(/[^a-zA-Z0-9-_]/g, '_').substring(0, 40);
        const safeArea = ((areacode || areaname) || 'Area').replace(/[^a-zA-Z0-9-]/g, '.').substring(0, 40);
        const safeCriteriaCode = (criteriacode || criterianame || 'Criteria').replace(/[^a-zA-Z0-9-]/g, '.').substring(0, 40);
        const safeReqCode = (requirementcode || 'Req').replace(/[^a-zA-Z0-9-]/g, '.').substring(0, 40);
        const safeUserName = userName.replace(/[^a-zA-Z0-9-]/g, '.').substring(0, 40);
        const ext = path.extname(req.file.originalname);

        const fileTitle = (displayname && displayname.trim())
            ? displayname.trim()
            : path.basename(req.file.originalname, ext);

        const safeTitle = fileTitle.replace(/[^a-zA-Z0-9-_]/g, '_').substring(0, 50);

        // Clean filename pattern without random numbers or timestamps
        const eventDir = path.join(__dirname, `../uploads/events/${safeEventName}`);
        if (!fs.existsSync(eventDir)) {
            fs.mkdirSync(eventDir, { recursive: true });
        }

        const baseFileName = `${safeEventName}.${safeArea}.${safeCriteriaCode}.${safeReqCode}.${safeUserName}_${safeTitle}`;
        let finalFileName = `${baseFileName}${ext}`;

        let collisionCounter = 1;
        while (fs.existsSync(path.join(eventDir, finalFileName))) {
            collisionCounter++;
            finalFileName = `${baseFileName}_${collisionCounter}${ext}`;
        }

        const safeOfficeName = officename.replace(/[^a-zA-Z0-9-_]/g, '_').substring(0, 40);
        const { uploadToSupabaseBucket } = require('../utils/supabaseStorage');

        const destPath = path.join(eventDir, finalFileName);
        let filepath = `/uploads/events/${safeEventName}/${finalFileName}`;
        let uploadedToCloud = false;

        try {
            const supabaseRes = await uploadToSupabaseBucket(
                req.file.path,
                `events/${safeEventName}/${safeOfficeName}/${finalFileName}`,
                req.file.mimetype
            );
            if (supabaseRes && supabaseRes.publicUrl) {
                filepath = supabaseRes.publicUrl;
                uploadedToCloud = true;
            }
        } catch (supabaseErr) {
            console.warn('Supabase cloud storage upload notice (falling back to local disk):', supabaseErr.message);
        }

        // Always ensure local copy exists as well (or if cloud upload fell back)
        try {
            if (!uploadedToCloud || !fs.existsSync(destPath)) {
                fs.copyFileSync(req.file.path, destPath);
            }
        } catch (copyErr) {
            console.warn('Local disk file write warning:', copyErr.message);
        }

        const fileComment = comment ? comment.trim() : '';

        // Calculate next sortorder so latest uploaded file is always at the bottom
        let nextSortOrder = 1;
        try {
            let sortQ = 'SELECT COALESCE(MAX(sortorder), 0) + 1 AS next_sort FROM officeproofdocuments WHERE requirementid = ? AND uploadedby = ?';
            let sortP = [requirementid, userid];
            if (finalResolvedOfficeId) {
                sortQ += ' AND officeid = ?';
                sortP.push(finalResolvedOfficeId);
            }
            const [sortRows] = await db.query(sortQ, sortP);
            if (sortRows && sortRows.length > 0) {
                nextSortOrder = Number(sortRows[0].next_sort || sortRows[0].next_sort || 1);
            }
        } catch (sErr) {
            console.warn('Sort order determination warning:', sErr.message);
        }

        await ensureReviewColumns(db);
        await ensureEvidenceSchema(db);

        const { insertResult, compliance } = await db.withTransaction(async (tx) => {
            const activeInTx = await getActiveUploadCount(tx, requirementid, userid, finalResolvedOfficeId);
            if (activeInTx >= MAX_ACTIVE_EVIDENCE_PER_PERSONNEL) {
                const limitErr = new Error(`Maximum limit of ${MAX_ACTIVE_EVIDENCE_PER_PERSONNEL} active uploaded files reached for this standard.`);
                limitErr.statusCode = 400;
                throw limitErr;
            }

            const [insRes] = await tx.query(
                `INSERT INTO officeproofdocuments
                 (officeid, uploadedby, requirementid, filename, displayname, comment, filepath, sortorder, reviewstatus, currentversion, uploadedat)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, NOW())`,
                [finalResolvedOfficeId, userid, requirementid, finalFileName, fileTitle, fileComment, filepath, nextSortOrder]
            );
            const newDocId = insRes?.insertId || insRes?.[0]?.id || insRes?.[0]?.ID;
            if (newDocId) {
                await tx.query(
                    `INSERT INTO officeproofdocumentversions
                     (documentid, versionno, filename, displayname, filepath, comment, submittedby, submittedat, reviewstatus)
                     VALUES (?, 1, ?, ?, ?, ?, ?, NOW(), 'pending')
                     ON CONFLICT (documentid, versionno) DO NOTHING`,
                    [Number(newDocId), finalFileName, fileTitle, filepath, fileComment || null, Number(userid)]
                );
            }
            const comp = await calculateStandardCompliance(tx, requirementid, finalResolvedOfficeId);
            await syncStandardComplianceStatus(tx, requirementid, finalResolvedOfficeId, comp);
            return { insertResult: insRes, compliance: comp };
        });

        // Update hasuploaded flag to TRUE for the specific office
        try {
            if (finalResolvedOfficeId) {
                await db.query(
                    'UPDATE requirementuserassignments SET hasuploaded = TRUE WHERE requirementid = ? AND userid = ? AND officeid = ?',
                    [requirementid, userid, finalResolvedOfficeId]
                );
            } else {
                await db.query(
                    'UPDATE requirementuserassignments SET hasuploaded = TRUE WHERE requirementid = ? AND userid = ?',
                    [requirementid, userid]
                );
            }
        } catch (hasUpErr) {
            console.warn('hasuploaded flag update notice:', hasUpErr.message);
        }

        try {
            const { createNotifications, getAdminUserIds } = require('../utils/notificationService');
            const actorUserId = Number(req.user?.userid || userid);
            const adminIds = await getAdminUserIds();

            let headUserIds = [];
            let auditorUserIds = [];

            if (finalResolvedOfficeId) {
                try {
                    // Get office heads
                    const [headRows] = await db.query(
                        `SELECT u.userid 
                         FROM users u
                         JOIN headofoffice h ON u.userid = h.userid
                         JOIN officeheadassignments oha ON h.headid = oha.headid
                         WHERE oha.officeid = ?`,
                        [finalResolvedOfficeId]
                    );
                    headUserIds = (headRows || []).map(r => Number(r.userid || r.userid)).filter(Boolean);
                } catch (hErr) { }

                try {
                    // Get auditors assigned to this office
                    const [auditorRows] = await db.query(
                        `SELECT aaa.auditoruserid as userid
                         FROM auditorareaassignments aaa
                         JOIN offices o ON o.officeid = ?
                         JOIN criteria c ON c.eventid = o.eventid
                         WHERE aaa.areaid = c.areaid`,
                        [finalResolvedOfficeId]
                    );
                    auditorUserIds = (auditorRows || []).map(r => Number(r.userid || r.userid)).filter(Boolean);
                } catch (aErr) { }
            }

            const allRecipientIds = [...new Set([...adminIds, ...headUserIds, ...auditorUserIds])];
            const uploaderDisplay = userName.replace(/_/g, ' ');

            if (allRecipientIds.length > 0 && finalResolvedOfficeId) {
                await createNotifications({
                    userIds: allRecipientIds.filter((id) => id !== actorUserId),
                    adminid: actorUserId,
                    title: 'New evidence uploaded',
                    message: `${uploaderDisplay} uploaded evidence for ${requirementcode || 'a requirement'} in ${officename}.`,
                    type: 'info',
                    relatedtable: 'requirement_file_upload',
                    relatedid: Number(finalResolvedOfficeId),
                    meta: {
                        officeid: Number(finalResolvedOfficeId),
                        requirementid: Number(requirementid),
                        viewUserId: Number(userid),
                        openSubmission: true,
                    },
                });
            }
        } catch (notifErr) {
            console.error('Failed to notify about file upload:', notifErr);
        }

        try {
            const actorUserId = Number(req.user?.userid || userid);
            if (Number.isInteger(actorUserId) && actorUserId > 0) {
                await recordLog(actorUserId, 'RequirementFileUploaded', {
                    requirementid: Number(requirementid),
                    requirementcode: requirementcode || null,
                    RequirementDescription: Description || null,
                    officeid: finalResolvedOfficeId ? Number(finalResolvedOfficeId) : null,
                    officename: officename || null,
                    eventname: eventname || null,
                    criterianame: criterianame || null,
                    FileName: finalFileName,
                    DisplayName: fileTitle,
                    Comment: fileComment,
                    UploadedByUserID: Number(userid),
                    UploadedByName: userName.replace(/_/g, ' '),
                });
            }
        } catch (logErr) {
            console.error('Failed to record upload log:', logErr);
        }

        const insertedId = insertResult?.insertId || insertResult?.[0]?.id || insertResult?.[0]?.ID || null;

        try {
            const { emitDataChange } = require('../socket');
            emitDataChange('requirements', { action: 'upload', requirementid, userid, officeid: finalResolvedOfficeId });
        } catch (sockErr) {
            // ignore
        }

        res.json({
            success: true,
            message: 'File uploaded successfully',
            compliance,
            file: {
                id: insertedId,
                filename: finalFileName,
                displayname: fileTitle,
                comment: fileComment,
                originalname: req.file.originalname,
                url: filepath,
                filepath,
                officeid: finalResolvedOfficeId,
                reviewstatus: 'pending',
                currentversion: 1,
                uploadedby: Number(userid),
                userid: Number(userid),
                uploadedat: new Date()
            }
        });
    } catch (error) {
        console.error('Error uploading user requirement file:', error);
        if (error.statusCode === 400) {
            return res.status(400).json({ success: false, message: error.message });
        }
        res.status(500).json({
            success: false,
            message: 'Error uploading file',
            error: error.message,
            stack: error.stack
        });
    }
});

// Get aggregated evidence compliance & per-personnel breakdown for a standard
router.get('/:requirementid/compliance', auth, async (req, res) => {
    try {
        const db = require('../db');
        const { requirementid } = req.params;
        const officeid = req.query.officeid ? Number(req.query.officeid) : null;
        await ensureEvidenceSchema(db);
        const compliance = await calculateStandardCompliance(db, requirementid, officeid);
        res.json({ success: true, compliance });
    } catch (error) {
        console.error('Error calculating standard compliance:', error);
        res.status(500).json({ success: false, message: 'Error calculating standard compliance', error: error.message });
    }
});

// Get full version and review history for an evidence document
router.get('/:requirementid/file/:fileId/history', auth, async (req, res) => {
    try {
        const db = require('../db');
        const { requirementid, fileId } = req.params;
        const history = await getDocumentHistory(db, fileId);
        if (!history || Number(history.document.requirementid) !== Number(requirementid)) {
            return res.status(404).json({ success: false, message: 'Evidence document not found' });
        }
        res.json({ success: true, ...history });
    } catch (error) {
        console.error('Error fetching evidence history:', error);
        res.status(500).json({ success: false, message: 'Error fetching evidence history', error: error.message });
    }
});

// Resubmit a rejected evidence document as a new version (never overwrites original file or adds an extra slot)
router.post('/:requirementid/file/:fileId/resubmit', auth, userReqUpload.single('file'), async (req, res) => {
    try {
        const db = require('../db');
        const { requirementid, fileId } = req.params;
        const actorUserId = Number(req.user?.userid || req.user?.id || 0);
        const actorRoleId = Number(req.user?.roleid || 0);

        if (actorRoleId === 4) {
            if (req.file?.path && fs.existsSync(req.file.path)) {
                try { fs.unlinkSync(req.file.path); } catch (e) { }
            }
            return res.status(403).json({ success: false, message: 'External Auditors are not permitted to resubmit evidence files.' });
        }

        if (!req.file) {
            return res.status(400).json({ success: false, message: 'A replacement file is required for resubmission.' });
        }

        await ensureReviewColumns(db);
        await ensureEvidenceSchema(db);

        const [docRows] = await db.query(
            `SELECT opd.*,
                    r.requirementcode, r.Description,
                    COALESCE(c.eventid, a.eventid) AS eventid,
                    e.eventname, e.eventcode,
                    c.criteriaid, c.criterianame, c.criteriacode,
                    a.areaid, a.areacode, a.areaname,
                    o.officename
             FROM officeproofdocuments opd
             LEFT JOIN requirements r ON opd.requirementid = r.requirementid
             LEFT JOIN criteria c ON r.criteriaid = c.criteriaid
             LEFT JOIN areas a ON c.areaid = a.areaid
             LEFT JOIN Events e ON COALESCE(c.eventid, a.eventid) = e.eventid
             LEFT JOIN offices o ON opd.officeid = o.officeid
             WHERE opd.id = ? AND opd.requirementid = ?
             LIMIT 1`,
            [Number(fileId), Number(requirementid)]
        );

        if (!docRows || docRows.length === 0) {
            if (req.file?.path && fs.existsSync(req.file.path)) {
                try { fs.unlinkSync(req.file.path); } catch (e) { }
            }
            return res.status(404).json({ success: false, message: 'Evidence document not found' });
        }

        const existingDoc = docRows[0];
        if (actorRoleId !== 1 && Number(existingDoc.uploadedby) !== actorUserId) {
            if (req.file?.path && fs.existsSync(req.file.path)) {
                try { fs.unlinkSync(req.file.path); } catch (e) { }
            }
            return res.status(403).json({ success: false, message: 'Forbidden: You can only resubmit your own evidence files.' });
        }

        if (String(existingDoc.reviewstatus || '').toLowerCase() !== 'rejected') {
            if (req.file?.path && fs.existsSync(req.file.path)) {
                try { fs.unlinkSync(req.file.path); } catch (e) { }
            }
            return res.status(400).json({ success: false, message: 'Only rejected evidence files can be resubmitted.' });
        }

        const nextVersion = Number(existingDoc.currentversion || 1) + 1;
        const ext = path.extname(req.file.originalname);
        const requestedTitle = (req.body.displayname || req.body.displayName || '').trim();
        const fileTitle = requestedTitle || existingDoc.displayname || path.basename(req.file.originalname, ext);
        const fileComment = req.body.comment !== undefined ? String(req.body.comment).trim() : (existingDoc.comment || '');

        const safeEventName = (existingDoc.eventcode || existingDoc.eventname || 'Event').replace(/[^a-zA-Z0-9-_]/g, '_').substring(0, 40);
        const safeArea = (existingDoc.areacode || existingDoc.areaname || 'Area').replace(/[^a-zA-Z0-9-]/g, '.').substring(0, 40);
        const safeCriteriaCode = (existingDoc.criteriacode || existingDoc.criterianame || 'Criteria').replace(/[^a-zA-Z0-9-]/g, '.').substring(0, 40);
        const safeReqCode = (existingDoc.requirementcode || 'Req').replace(/[^a-zA-Z0-9-]/g, '.').substring(0, 40);
        const safeTitle = fileTitle.replace(/[^a-zA-Z0-9-_]/g, '_').substring(0, 50);
        const safeOfficeName = (existingDoc.officename || 'Office').replace(/[^a-zA-Z0-9-_]/g, '_').substring(0, 40);

        const eventDir = path.join(__dirname, `../uploads/events/${safeEventName}`);
        if (!fs.existsSync(eventDir)) {
            fs.mkdirSync(eventDir, { recursive: true });
        }

        const baseFileName = `${safeEventName}.${safeArea}.${safeCriteriaCode}.${safeReqCode}.${safeTitle}_v${nextVersion}`;
        let finalFileName = `${baseFileName}${ext}`;
        let collisionCounter = 1;
        while (fs.existsSync(path.join(eventDir, finalFileName))) {
            collisionCounter++;
            finalFileName = `${baseFileName}_${collisionCounter}${ext}`;
        }

        const destPath = path.join(eventDir, finalFileName);
        let filepath = `/uploads/events/${safeEventName}/${finalFileName}`;
        let uploadedToCloud = false;

        try {
            const { uploadToSupabaseBucket } = require('../utils/supabaseStorage');
            const supabaseRes = await uploadToSupabaseBucket(
                req.file.path,
                `events/${safeEventName}/${safeOfficeName}/${finalFileName}`,
                req.file.mimetype
            );
            if (supabaseRes && supabaseRes.publicUrl) {
                filepath = supabaseRes.publicUrl;
                uploadedToCloud = true;
            }
        } catch (supabaseErr) {
            console.warn('Supabase cloud storage resubmission fallback to local disk:', supabaseErr.message);
        }

        try {
            if (!uploadedToCloud || !fs.existsSync(destPath)) {
                fs.copyFileSync(req.file.path, destPath);
            }
        } catch (copyErr) {
            console.warn('Local disk resubmission copy warning:', copyErr.message);
        }

        try {
            if (req.file?.path && fs.existsSync(req.file.path)) {
                fs.unlinkSync(req.file.path);
            }
        } catch (unlinkErr) { }

        const { updatedDoc, compliance } = await db.withTransaction(async (tx) => {
            const [lockedRows] = await tx.query(
                `SELECT * FROM officeproofdocuments WHERE id = ? AND requirementid = ? FOR UPDATE`,
                [Number(fileId), Number(requirementid)]
            );
            const lockedDoc = lockedRows?.[0];
            if (!lockedDoc) {
                const err = new Error('Evidence document not found');
                err.statusCode = 404;
                throw err;
            }
            if (String(lockedDoc.reviewstatus || '').toLowerCase() !== 'rejected') {
                const err = new Error('Only rejected evidence files can be resubmitted.');
                err.statusCode = 400;
                throw err;
            }

            await syncInitialVersionIfMissing(tx, lockedDoc);
            const verNo = Number(lockedDoc.currentversion || 1) + 1;

            await tx.query(
                `INSERT INTO officeproofdocumentversions
                 (documentid, versionno, filename, displayname, filepath, comment, submittedby, submittedat, reviewstatus)
                 VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), 'pending')`,
                [Number(fileId), verNo, finalFileName, fileTitle, filepath, fileComment || null, actorUserId]
            );

            const [updRows] = await tx.query(
                `UPDATE officeproofdocuments
                 SET filename = ?,
                     displayname = ?,
                     filepath = ?,
                     comment = ?,
                     currentversion = ?,
                     reviewstatus = 'pending',
                     rejectionreason = NULL,
                     reviewedby = NULL,
                     reviewedat = NULL,
                     uploadedat = NOW()
                 WHERE id = ?
                 RETURNING *`,
                [finalFileName, fileTitle, filepath, fileComment, verNo, Number(fileId)]
            );

            const comp = await calculateStandardCompliance(tx, requirementid, lockedDoc.officeid);
            await syncStandardComplianceStatus(tx, requirementid, lockedDoc.officeid, comp);
            return { updatedDoc: updRows?.[0], compliance: comp };
        });

        try {
            const { createNotifications, getAdminUserIds } = require('../utils/notificationService');
            const adminIds = await getAdminUserIds();
            let headUserIds = [];
            let auditorUserIds = [];

            if (existingDoc.officeid) {
                const [headRows] = await db.query(
                    `SELECT u.userid FROM users u
                     JOIN headofoffice h ON u.userid = h.userid
                     JOIN officeheadassignments oha ON h.headid = oha.headid
                     WHERE oha.officeid = ?`,
                    [Number(existingDoc.officeid)]
                );
                headUserIds = (headRows || []).map(r => Number(r.userid)).filter(Boolean);

                const [audRows] = await db.query(
                    `SELECT userid FROM officeauditorassignments WHERE officeid = ?`,
                    [Number(existingDoc.officeid)]
                );
                auditorUserIds = (audRows || []).map(r => Number(r.userid)).filter(Boolean);
            }

            const recipients = [...new Set([...adminIds, ...headUserIds, ...auditorUserIds])]
                .filter(id => id && id !== actorUserId);

            if (recipients.length > 0) {
                await createNotifications({
                    userIds: recipients,
                    adminid: actorUserId,
                    title: 'Evidence Resubmitted',
                    message: `Evidence "${fileTitle}" for ${existingDoc.requirementcode || 'a standard'} was resubmitted (v${updatedDoc.currentversion}) and is pending review.`,
                    type: 'info',
                    relatedtable: 'requirement_file_resubmitted',
                    relatedid: existingDoc.officeid ? Number(existingDoc.officeid) : Number(requirementid),
                    meta: {
                        officeid: existingDoc.officeid ? Number(existingDoc.officeid) : null,
                        requirementid: Number(requirementid),
                        fileId: Number(fileId),
                        openSubmission: true
                    }
                });
            }
        } catch (notifErr) {
            console.warn('Resubmission notification warning:', notifErr.message);
        }

        try {
            if (actorUserId > 0) {
                await recordLog(actorUserId, 'RequirementFileResubmitted', {
                    requirementid: Number(requirementid),
                    requirementcode: existingDoc.requirementcode || null,
                    officeid: existingDoc.officeid ? Number(existingDoc.officeid) : null,
                    fileId: Number(fileId),
                    versionno: Number(updatedDoc.currentversion),
                    FileName: finalFileName,
                    DisplayName: fileTitle
                });
            }
        } catch (logErr) {
            console.warn('Resubmission log warning:', logErr.message);
        }

        try {
            const { emitDataChange } = require('../socket');
            emitDataChange('requirements', {
                action: 'resubmit',
                requirementid: Number(requirementid),
                fileId: Number(fileId),
                userid: Number(existingDoc.uploadedby),
                officeid: existingDoc.officeid ? Number(existingDoc.officeid) : null,
                compliance
            });
        } catch (sockErr) { }

        res.json({
            success: true,
            message: 'Evidence resubmitted successfully',
            compliance,
            file: {
                id: updatedDoc.id,
                filename: updatedDoc.filename,
                displayname: updatedDoc.displayname,
                comment: updatedDoc.comment || '',
                filepath: updatedDoc.filepath,
                url: updatedDoc.filepath,
                officeid: updatedDoc.officeid,
                uploadedby: updatedDoc.uploadedby,
                userid: updatedDoc.uploadedby,
                reviewstatus: 'pending',
                rejectionreason: '',
                reviewedby: null,
                reviewedat: null,
                reviewerName: null,
                currentversion: Number(updatedDoc.currentversion),
                uploadedat: updatedDoc.uploadedat
            }
        });
    } catch (error) {
        console.error('Error resubmitting evidence file:', error);
        if (error.statusCode) {
            return res.status(error.statusCode).json({ success: false, message: error.message });
        }
        res.status(500).json({ success: false, message: 'Error resubmitting evidence file', error: error.message });
    }
});

// Get Facebook-style comments for a submitted evidence file
router.get('/:requirementid/file/:fileId/comments', auth, async (req, res) => {
    try {
        const db = require('../db');
        const { requirementid, fileId } = req.params;
        const actorRole = Number(req.user?.roleid || 0);

        await ensureEvidenceSchema(db);

        const [docRows] = await db.query(
            `SELECT id, requirementid, officeid, uploadedby, reviewstatus
             FROM officeproofdocuments
             WHERE id = ? AND requirementid = ?
             LIMIT 1`,
            [Number(fileId), Number(requirementid)]
        );
        if (!docRows || docRows.length === 0) {
            return res.status(404).json({ success: false, message: 'Evidence document not found' });
        }

        const doc = docRows[0];
        if (actorRole === 4 && String(doc.reviewstatus || '').toLowerCase() !== 'approved') {
            return res.status(403).json({
                success: false,
                message: 'External Auditors can only view comments on approved evidence files.'
            });
        }

        const [rows] = await db.query(
            `SELECT c.id,
                    c.documentid,
                    c.userid,
                    c.comment,
                    c.createdat,
                    u.firstname,
                    u.middleinitial,
                    u.lastname,
                    u.profilepic,
                    u.roleid,
                    r.rolename
             FROM officeproofdocumentcomments c
             JOIN users u ON c.userid = u.userid
             LEFT JOIN roles r ON u.roleid = r.roleid
             WHERE c.documentid = ?
             ORDER BY c.createdat ASC, c.id ASC`,
            [Number(fileId)]
        );

        const comments = (rows || []).map(row => {
            const roleIdNum = Number(row.roleid || 0);
            const roleLabel = roleIdNum === 1
                ? 'Admin'
                : roleIdNum === 4
                    ? 'External Auditor'
                    : (row.rolename || 'Personnel');
            const fullName = [row.firstname, row.middleinitial, row.lastname].filter(Boolean).join(' ').trim() || 'User';
            return {
                id: row.id,
                documentid: row.documentid,
                userid: row.userid,
                comment: row.comment,
                createdat: row.createdat,
                firstname: row.firstname,
                lastname: row.lastname,
                fullName,
                profilepic: row.profilepic || null,
                roleid: roleIdNum,
                roleLabel
            };
        });

        res.json({ success: true, comments });
    } catch (error) {
        console.error('Error fetching file comments:', error);
        res.status(500).json({ success: false, message: 'Error fetching file comments', error: error.message });
    }
});

// Post a comment on a submitted evidence file (External Auditor on approved files only)
router.post('/:requirementid/file/:fileId/comments', auth, async (req, res) => {
    try {
        const db = require('../db');
        const { requirementid, fileId } = req.params;
        const actorId = Number(req.user?.userid || req.user?.id || 0);
        const actorRole = Number(req.user?.roleid || 0);
        const rawComment = req.body?.comment;
        const trimmedComment = typeof rawComment === 'string' ? rawComment.trim() : '';

        if (!trimmedComment) {
            return res.status(400).json({ success: false, message: 'Comment text is required.' });
        }

        if (actorRole !== 4) {
            return res.status(403).json({
                success: false,
                message: 'Only External Auditors can post comments on approved evidence files.'
            });
        }

        await ensureEvidenceSchema(db);

        const [docRows] = await db.query(
            `SELECT opd.id, opd.requirementid, opd.officeid, opd.uploadedby, opd.reviewstatus, opd.displayname, opd.filename,
                    req.requirementcode
             FROM officeproofdocuments opd
             LEFT JOIN requirements req ON opd.requirementid = req.requirementid
             WHERE opd.id = ? AND opd.requirementid = ?
             LIMIT 1`,
            [Number(fileId), Number(requirementid)]
        );
        if (!docRows || docRows.length === 0) {
            return res.status(404).json({ success: false, message: 'Evidence document not found' });
        }

        const doc = docRows[0];
        if (actorRole === 4 && String(doc.reviewstatus || '').toLowerCase() !== 'approved') {
            return res.status(403).json({
                success: false,
                message: 'External Auditors can only comment on approved evidence files.'
            });
        }

        const [insRows] = await db.query(
            `INSERT INTO officeproofdocumentcomments (documentid, userid, comment, createdat)
             VALUES (?, ?, ?, CURRENT_TIMESTAMP)
             RETURNING id, documentid, userid, comment, createdat`,
            [Number(fileId), actorId, trimmedComment]
        );
        const inserted = insRows[0];

        const [userRows] = await db.query(
            `SELECT u.userid, u.firstname, u.middleinitial, u.lastname, u.profilepic, u.roleid, r.rolename
             FROM users u
             LEFT JOIN roles r ON u.roleid = r.roleid
             WHERE u.userid = ?
             LIMIT 1`,
            [actorId]
        );
        const u = userRows?.[0] || {};
        const roleIdNum = Number(u.roleid || actorRole || 0);
        const roleLabel = roleIdNum === 1 ? 'Admin' : roleIdNum === 4 ? 'External Auditor' : (u.rolename || 'Personnel');
        const fullName = [u.firstname, u.middleinitial, u.lastname].filter(Boolean).join(' ').trim() || 'User';

        const commentPayload = {
            id: inserted.id,
            documentid: inserted.documentid,
            userid: inserted.userid,
            comment: inserted.comment,
            createdat: inserted.createdat,
            firstname: u.firstname || '',
            lastname: u.lastname || '',
            fullName,
            profilepic: u.profilepic || null,
            roleid: roleIdNum,
            roleLabel
        };

        try {
            const uploaderId = Number(doc.uploadedby || 0);
            if (uploaderId && uploaderId !== actorId) {
                const { createNotifications } = require('../utils/notificationService');
                const fileTitle = doc.displayname || doc.filename || 'your submitted file';
                await createNotifications({
                    userIds: [uploaderId],
                    adminid: actorId,
                    title: `New Comment from ${roleLabel}`,
                    message: `${fullName} (${roleLabel}) commented on "${fileTitle}" (${doc.requirementcode || 'Standard'}): "${trimmedComment.slice(0, 100)}"`,
                    type: 'info',
                    relatedtable: 'requirement_file_comment',
                    relatedid: Number(doc.officeid || requirementid),
                    meta: {
                        officeid: doc.officeid ? Number(doc.officeid) : null,
                        requirementid: Number(requirementid),
                        fileId: Number(fileId),
                        openSubmission: true
                    }
                });
            }
        } catch (notifErr) {
            console.warn('File comment notification warning:', notifErr.message);
        }

        try {
            const { emitDataChange } = require('../socket');
            emitDataChange('requirements', {
                action: 'file_comment',
                requirementid: Number(requirementid),
                fileId: Number(fileId),
                comment: commentPayload
            });
        } catch (sockErr) { }

        res.json({ success: true, comment: commentPayload });
    } catch (error) {
        console.error('Error posting file comment:', error);
        res.status(500).json({ success: false, message: 'Error posting file comment', error: error.message });
    }
});

// Delete a comment on a submitted evidence file (author or Admin)
router.delete('/:requirementid/file/:fileId/comments/:commentId', auth, async (req, res) => {
    try {
        const db = require('../db');
        const { requirementid, fileId, commentId } = req.params;
        const actorId = Number(req.user?.userid || req.user?.id || 0);
        const actorRole = Number(req.user?.roleid || 0);

        const [rows] = await db.query(
            `SELECT c.id, c.userid
             FROM officeproofdocumentcomments c
             JOIN officeproofdocuments d ON c.documentid = d.id
             WHERE c.id = ? AND c.documentid = ? AND d.requirementid = ?
             LIMIT 1`,
            [Number(commentId), Number(fileId), Number(requirementid)]
        );
        if (!rows || rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Comment not found' });
        }

        if (actorRole !== 1 && Number(rows[0].userid) !== actorId) {
            return res.status(403).json({ success: false, message: 'Forbidden: You can only delete your own comments.' });
        }

        await db.query(`DELETE FROM officeproofdocumentcomments WHERE id = ?`, [Number(commentId)]);

        try {
            const { emitDataChange } = require('../socket');
            emitDataChange('requirements', {
                action: 'file_comment_deleted',
                requirementid: Number(requirementid),
                fileId: Number(fileId),
                commentId: Number(commentId)
            });
        } catch (sockErr) { }

        res.json({ success: true, message: 'Comment deleted' });
    } catch (error) {
        console.error('Error deleting file comment:', error);
        res.status(500).json({ success: false, message: 'Error deleting file comment', error: error.message });
    }
});

function formatThreadCommentRow(row) {
    const roleIdNum = Number(row.roleid || 0);
    const roleLabel = roleIdNum === 1
        ? 'Admin'
        : roleIdNum === 4
            ? 'External Auditor'
            : (row.rolename || 'Personnel');
    const fullName = [row.firstname, row.middleinitial, row.lastname].filter(Boolean).join(' ').trim() || 'User';
    return {
        id: row.id,
        requirementid: row.requirementid,
        officeid: row.officeid,
        userid: row.userid,
        comment: row.comment,
        createdat: row.createdat,
        firstname: row.firstname,
        middleinitial: row.middleinitial,
        lastname: row.lastname,
        fullName,
        profilepic: row.profilepic || null,
        roleid: roleIdNum,
        roleLabel,
    };
}

// Get Facebook-style comments for a requirement within an office
router.get('/:requirementid/comments', auth, async (req, res) => {
    try {
        const db = require('../db');
        const requirementid = Number(req.params.requirementid);
        const officeid = Number(req.query.officeid);

        if (!Number.isInteger(requirementid) || requirementid <= 0 || !Number.isInteger(officeid) || officeid <= 0) {
            return res.status(400).json({ success: false, message: 'Valid requirementid and officeid are required' });
        }

        await ensureEvidenceSchema(db);

        const [rows] = await db.query(
            `SELECT c.id,
                    c.requirementid,
                    c.officeid,
                    c.userid,
                    c.comment,
                    c.createdat,
                    u.firstname,
                    u.middleinitial,
                    u.lastname,
                    u.profilepic,
                    u.roleid,
                    r.rolename
             FROM requirementcomments c
             JOIN users u ON c.userid = u.userid
             LEFT JOIN roles r ON u.roleid = r.roleid
             WHERE c.requirementid = ? AND c.officeid = ?
             ORDER BY c.createdat ASC, c.id ASC`,
            [requirementid, officeid]
        );

        res.json({ success: true, comments: (rows || []).map(formatThreadCommentRow) });
    } catch (error) {
        console.error('Error fetching requirement comments:', error);
        res.status(500).json({ success: false, message: 'Error fetching requirement comments', error: error.message });
    }
});

// Post a Facebook-style comment on a requirement (Admin or External Auditor)
router.post('/:requirementid/comments', auth, async (req, res) => {
    try {
        const db = require('../db');
        const requirementid = Number(req.params.requirementid);
        const officeid = Number(req.body?.officeid);
        const trimmed = String(req.body?.comment || '').trim();
        const actorId = Number(req.user?.userid || 0);
        const actorRole = Number(req.user?.roleid || 0);

        if (actorRole !== 1 && actorRole !== 4) {
            return res.status(403).json({
                success: false,
                message: 'Only Admins and External Auditors can comment on requirements.'
            });
        }

        if (!Number.isInteger(requirementid) || requirementid <= 0 || !Number.isInteger(officeid) || officeid <= 0) {
            return res.status(400).json({ success: false, message: 'Valid requirementid and officeid are required' });
        }

        if (!trimmed) {
            return res.status(400).json({ success: false, message: 'Comment text is required' });
        }

        await ensureEvidenceSchema(db);

        const [inserted] = await db.query(
            `INSERT INTO requirementcomments (requirementid, officeid, userid, comment)
             VALUES (?, ?, ?, ?)
             RETURNING id, requirementid, officeid, userid, comment, createdat`,
            [requirementid, officeid, actorId, trimmed]
        );
        const newRow = inserted[0];

        const [userRows] = await db.query(
            `SELECT u.userid, u.firstname, u.middleinitial, u.lastname, u.profilepic, u.roleid, r.rolename
             FROM users u
             LEFT JOIN roles r ON u.roleid = r.roleid
             WHERE u.userid = ?
             LIMIT 1`,
            [actorId]
        );
        const commentObj = formatThreadCommentRow({ ...newRow, ...(userRows?.[0] || {}) });

        // Notify assigned personnel for this requirement & office
        try {
            const [assignedRows] = await db.query(
                `SELECT DISTINCT userid
                 FROM requirementuserassignments
                 WHERE requirementid = ? AND officeid = ?`,
                [requirementid, officeid]
            );
            const targetUserIds = (assignedRows || [])
                .map((r) => Number(r.userid))
                .filter((uid) => Number.isInteger(uid) && uid > 0 && uid !== actorId);

            if (targetUserIds.length > 0) {
                const [reqRows] = await db.query(
                    `SELECT requirementcode FROM requirements WHERE requirementid = ? LIMIT 1`,
                    [requirementid]
                );
                const reqCode = reqRows?.[0]?.requirementcode || `#${requirementid}`;
                const { createNotifications } = require('../utils/notificationService');
                await createNotifications({
                    userIds: targetUserIds,
                    adminid: actorId,
                    title: `New Comment from ${commentObj.roleLabel}`,
                    message: `${commentObj.fullName} (${commentObj.roleLabel}) commented on requirement ${reqCode}: "${trimmed.slice(0, 120)}${trimmed.length > 120 ? '...' : ''}"`,
                    type: 'info',
                    relatedtable: 'requirement_comment',
                    relatedid: Number(newRow.id),
                    meta: {
                        officeid,
                        requirementid,
                        commentId: Number(newRow.id),
                    },
                });
            }
        } catch (notifErr) {
            console.warn('Requirement comment notification warning:', notifErr?.message || notifErr);
        }

        try {
            const { emitDataChange } = require('../socket');
            emitDataChange('requirements', {
                action: 'requirement_comment',
                requirementid,
                officeid,
                comment: commentObj,
            });
        } catch (sockErr) { }

        res.json({ success: true, comment: commentObj });
    } catch (error) {
        console.error('Error posting requirement comment:', error);
        res.status(500).json({ success: false, message: 'Error posting requirement comment', error: error.message });
    }
});

// Delete a requirement-level comment (Admin or comment author)
router.delete('/:requirementid/comments/:commentId', auth, async (req, res) => {
    try {
        const db = require('../db');
        const requirementid = Number(req.params.requirementid);
        const commentId = Number(req.params.commentId);
        const actorId = Number(req.user?.userid || 0);
        const actorRole = Number(req.user?.roleid || 0);

        await ensureEvidenceSchema(db);

        const [rows] = await db.query(
            `SELECT id, userid, officeid FROM requirementcomments WHERE id = ? AND requirementid = ? LIMIT 1`,
            [commentId, requirementid]
        );
        if (!rows || rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Comment not found' });
        }

        if (actorRole !== 1 && Number(rows[0].userid) !== actorId) {
            return res.status(403).json({ success: false, message: 'Forbidden: You can only delete your own comments.' });
        }

        await db.query(`DELETE FROM requirementcomments WHERE id = ?`, [commentId]);

        try {
            const { emitDataChange } = require('../socket');
            emitDataChange('requirements', {
                action: 'requirement_comment_deleted',
                requirementid,
                officeid: Number(rows[0].officeid || 0),
                commentId,
            });
        } catch (sockErr) { }

        res.json({ success: true, message: 'Comment deleted' });
    } catch (error) {
        console.error('Error deleting requirement comment:', error);
        res.status(500).json({ success: false, message: 'Error deleting requirement comment', error: error.message });
    }
});

// Events routes (legacy - keeping for compatibility)
router.get('/', requirementsController.getAllEvents);
router.post('/add-event', requirementsController.addEvent);
router.post('/delete-events', requirementsController.deleteEvents);
router.put('/update-event/:id', requirementsController.updateEvent);

module.exports = router;
