const MAX_ACTIVE_EVIDENCE_PER_PERSONNEL = 40;

let schemaEnsured = false;

/**
 * Ensures versioning columns and history table exist for evidence documents.
 */
async function ensureEvidenceSchema(db) {
    if (schemaEnsured) return;
    try {
        await db.query(`ALTER TABLE officeproofdocuments ADD COLUMN IF NOT EXISTS currentversion INT DEFAULT 1`);
        await db.query(`
            CREATE TABLE IF NOT EXISTS officeproofdocumentversions (
                id SERIAL PRIMARY KEY,
                documentid INT NOT NULL REFERENCES officeproofdocuments(id) ON DELETE CASCADE,
                versionno INT NOT NULL,
                filename VARCHAR(500) NOT NULL,
                displayname VARCHAR(500),
                filepath VARCHAR(1000) NOT NULL,
                comment TEXT,
                submittedby INT REFERENCES users(userid) ON DELETE SET NULL,
                submittedat TIMESTAMP DEFAULT NOW(),
                reviewstatus VARCHAR(50) DEFAULT 'pending',
                rejectionreason TEXT,
                reviewedby INT REFERENCES users(userid) ON DELETE SET NULL,
                reviewedat TIMESTAMP,
                CONSTRAINT uq_proof_version UNIQUE (documentid, versionno)
            )
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS officeproofdocumentcomments (
                id SERIAL PRIMARY KEY,
                documentid INT NOT NULL REFERENCES officeproofdocuments(id) ON DELETE CASCADE,
                userid INT NOT NULL REFERENCES users(userid) ON DELETE CASCADE,
                comment TEXT NOT NULL,
                createdat TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await db.query(`
            CREATE INDEX IF NOT EXISTS idx_proof_comments_doc_created
            ON officeproofdocumentcomments(documentid, createdat)
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS requirementcomments (
                id SERIAL PRIMARY KEY,
                requirementid INT NOT NULL REFERENCES requirements(requirementid) ON DELETE CASCADE,
                officeid INT NOT NULL REFERENCES offices(officeid) ON DELETE CASCADE,
                userid INT NOT NULL REFERENCES users(userid) ON DELETE CASCADE,
                comment TEXT NOT NULL,
                createdat TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await db.query(`
            CREATE INDEX IF NOT EXISTS idx_req_comments_req_office_created
            ON requirementcomments(requirementid, officeid, createdat, id)
        `);
        schemaEnsured = true;
    } catch (err) {
        console.warn('[evidenceService] ensureEvidenceSchema warning:', err.message);
    }
}

/**
 * Lazily backfills version 1 into officeproofdocumentversions for legacy records
 * that existed before version tracking was enabled.
 */
async function syncInitialVersionIfMissing(db, docRow) {
    if (!docRow || !docRow.id) return;
    await ensureEvidenceSchema(db);
    const [existing] = await db.query(
        `SELECT 1 FROM officeproofdocumentversions WHERE documentid = ? LIMIT 1`,
        [Number(docRow.id)]
    );
    if (existing && existing.length > 0) return;

    const versionNo = Number(docRow.currentversion || 1);
    const reviewStatus = String(docRow.reviewstatus || 'pending').toLowerCase();
    await db.query(
        `INSERT INTO officeproofdocumentversions
         (documentid, versionno, filename, displayname, filepath, comment, submittedby, submittedat, reviewstatus, rejectionreason, reviewedby, reviewedat)
         VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, NOW()), ?, ?, ?, ?)
         ON CONFLICT (documentid, versionno) DO NOTHING`,
        [
            Number(docRow.id),
            versionNo,
            docRow.filename,
            docRow.displayname || docRow.filename,
            docRow.filepath,
            docRow.comment || null,
            docRow.uploadedby ? Number(docRow.uploadedby) : null,
            docRow.uploadedat || null,
            reviewStatus,
            docRow.rejectionreason || null,
            docRow.reviewedby ? Number(docRow.reviewedby) : null,
            docRow.reviewedat || null
        ]
    );
}

/**
 * Returns the number of active evidence slots (approved + pending) used by a
 * personnel member for a specific standard (and optional office).
 * Rejected records do NOT consume an upload slot.
 */
async function getActiveUploadCount(db, requirementid, userid, officeid = null) {
    let query = `
        SELECT COUNT(*) AS cnt
        FROM officeproofdocuments
        WHERE requirementid = ?
          AND uploadedby = ?
          AND LOWER(COALESCE(reviewstatus, 'pending')) IN ('approved', 'pending')
    `;
    const params = [Number(requirementid), Number(userid)];
    if (officeid) {
        query += ` AND officeid = ?`;
        params.push(Number(officeid));
    }
    const [rows] = await db.query(query, params);
    return Number(rows?.[0]?.cnt ?? rows?.[0]?.count ?? 0);
}

function deriveComplianceStatus(totalRecords, approvalRate) {
    if (!totalRecords || Number(totalRecords) <= 0) {
        return { derivedStatusId: 2, derivedStatusName: 'Non-Existent', dbStatusId: 3 };
    }
    const rate = Number(approvalRate || 0);
    if (rate >= 100) {
        return { derivedStatusId: 5, derivedStatusName: 'Complied', dbStatusId: 5 };
    }
    if (rate > 0) {
        return { derivedStatusId: 4, derivedStatusName: 'Partially Complied', dbStatusId: 4 };
    }
    return { derivedStatusId: 3, derivedStatusName: 'Not Complied', dbStatusId: 3 };
}

function buildComplianceSummary(approvedCount, pendingCount, rejectedCount, assignedPersonnelCount, personnelBreakdown = []) {
    const approved = Number(approvedCount || 0);
    const pending = Number(pendingCount || 0);
    const rejected = Number(rejectedCount || 0);
    const active = approved + pending;
    const totalRecords = active + rejected;
    // Formula: (Total Approved Evidence Records / Total Submitted Evidence Records) * 100
    const approvalRate = totalRecords > 0 ? Number(((approved / totalRecords) * 100).toFixed(2)) : 0;
    const { derivedStatusId, derivedStatusName, dbStatusId } = deriveComplianceStatus(totalRecords, approvalRate);

    return {
        approvalRate,
        compliancePercentage: approvalRate,
        approvedCount: approved,
        pendingCount: pending,
        rejectedCount: rejected,
        activeCount: active,
        totalRecords,
        totalSubmittedCount: totalRecords,
        assignedPersonnelCount: Number(assignedPersonnelCount || 0),
        hasEvidence: totalRecords > 0,
        hasActiveEvidence: active > 0,
        statusLabel: totalRecords > 0 ? `${approvalRate}%` : 'No Evidence Submitted',
        derivedStatusId,
        derivedStatusName,
        dbStatusId,
        personnelBreakdown
    };
}

/**
 * Automatically synchronizes compliancestatusoffices.Status and offices.OverallComplianceStatus
 * from the calculated evidence compliance percentage so manual status entry is unnecessary.
 */
async function syncStandardComplianceStatus(db, requirementid, officeid, precomputedCompliance = null) {
    if (!requirementid || !officeid) return null;
    const reqIdNum = Number(requirementid);
    const officeIdNum = Number(officeid);
    const compliance = precomputedCompliance || (await calculateStandardCompliance(db, reqIdNum, officeIdNum));
    const nextDbStatusId = compliance.dbStatusId || 3;

    try {
        await db.query(
            `UPDATE compliancestatusoffices
             SET Status = ?, LastUpdated = CURRENT_TIMESTAMP
             WHERE officeid = ? AND requirementid = ?`,
            [nextDbStatusId, officeIdNum, reqIdNum]
        );

        const [counts] = await db.query(
            `SELECT
                COUNT(*) AS totalrequirements,
                SUM(CASE WHEN req_stats.total_files > 0 AND req_stats.approved_files = req_stats.total_files THEN 1 ELSE 0 END) AS compliedcount,
                SUM(CASE WHEN req_stats.total_files > 0 AND req_stats.approved_files > 0 AND req_stats.approved_files < req_stats.total_files THEN 1 ELSE 0 END) AS partiallycompliedcount,
                SUM(CASE WHEN req_stats.total_files = 0 OR req_stats.approved_files = 0 THEN 1 ELSE 0 END) AS notcompliedcount,
                SUM(req_stats.total_files) AS totalevidence,
                SUM(req_stats.approved_files) AS approvedevidence,
                ROUND(COALESCE(AVG(req_stats.req_pct), 0)::numeric, 2) AS avgcompliancepercent
             FROM (
                SELECT
                    cso.requirementid,
                    COUNT(opd.id) AS total_files,
                    SUM(CASE WHEN LOWER(COALESCE(opd.reviewstatus, 'pending')) = 'approved' THEN 1 ELSE 0 END) AS approved_files,
                    CASE
                        WHEN COUNT(opd.id) = 0 THEN 0.0
                        ELSE (SUM(CASE WHEN LOWER(COALESCE(opd.reviewstatus, 'pending')) = 'approved' THEN 1.0 ELSE 0.0 END) * 100.0 / COUNT(opd.id))
                    END AS req_pct
                FROM compliancestatusoffices cso
                LEFT JOIN officeproofdocuments opd
                  ON opd.officeid = cso.officeid AND opd.requirementid = cso.requirementid
                WHERE cso.officeid = ?
                GROUP BY cso.requirementid
             ) req_stats`,
            [officeIdNum]
        );
        const total = Number(counts?.[0]?.totalrequirements || 0);
        const complied = Number(counts?.[0]?.compliedcount || 0);
        const partially = Number(counts?.[0]?.partiallycompliedcount || 0);
        const notComplied = Number(counts?.[0]?.notcompliedcount || 0);
        const totalEvidence = Number(counts?.[0]?.totalevidence || 0);
        const approvedEvidence = Number(counts?.[0]?.approvedevidence || 0);
        const compliancepercent = Number(counts?.[0]?.avgcompliancepercent || 0);
        if (total > 0) {
            let overallstatus = 'Partially Complied';
            if (totalEvidence === 0) overallstatus = 'Non-Existent';
            else if (complied === total) overallstatus = 'Complied';
            else if (approvedEvidence === 0) overallstatus = 'Not Complied';

            await db.query(
                `INSERT INTO OverallOfficeStatus
                    (officeid, compliedcount, partiallycompliedcount, notcompliedcount, totalrequirements, compliancepercent, overallstatus)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (officeid) DO UPDATE SET
                    compliedcount = EXCLUDED.compliedcount,
                    partiallycompliedcount = EXCLUDED.partiallycompliedcount,
                    notcompliedcount = EXCLUDED.notcompliedcount,
                    totalrequirements = EXCLUDED.totalrequirements,
                    compliancepercent = EXCLUDED.compliancepercent,
                    overallstatus = EXCLUDED.overallstatus,
                    lastupdated = CURRENT_TIMESTAMP`,
                [officeIdNum, complied, partially, notComplied, total, compliancepercent.toFixed(2), overallstatus]
            );
        }
    } catch (syncErr) {
        console.warn('[evidenceService] syncStandardComplianceStatus warning:', syncErr.message);
    }

    return compliance;
}

/**
 * Collects unique assigned user IDs (and optionally user details) per requirementid
 * across requirementuserassignments, personnelassignments, and officeheadassignments.
 */
async function getAssignedPersonnelMap(db, requirementIds, officeid = null, includeUserDetails = false) {
    const ids = [...new Set((requirementIds || []).map(Number).filter(n => Number.isInteger(n) && n > 0))];
    const map = new Map();
    for (const id of ids) map.set(id, new Map());
    if (ids.length === 0) return map;

    const officeIdNum = officeid ? Number(officeid) : null;
    const idPlaceholders = ids.map(() => '?').join(',');

    // 1. Direct requirementuserassignments
    let ruaQuery = `
        SELECT DISTINCT rua.requirementid, rua.userid
        FROM requirementuserassignments rua
        WHERE rua.requirementid IN (${idPlaceholders})
    `;
    const ruaParams = [...ids];
    if (officeIdNum) {
        ruaQuery += ` AND (rua.officeid = ? OR rua.officeid IS NULL)`;
        ruaParams.push(officeIdNum);
    }

    // 2. Scoped personnelassignments (requirement, criteria, parent criteria, or area within event)
    let eventId = null;
    if (officeIdNum) {
        try {
            const [offRows] = await db.query(`SELECT eventid FROM offices WHERE officeid = ? LIMIT 1`, [officeIdNum]);
            eventId = offRows?.[0]?.eventid ? Number(offRows[0].eventid) : null;
        } catch (e) {}
    }

    const paQuery = `
        SELECT DISTINCT r.requirementid, pa.userid
        FROM requirements r
        LEFT JOIN criteria c ON r.criteriaid = c.criteriaid
        LEFT JOIN criteria pc ON c.parentcriteriaid = pc.criteriaid
        JOIN personnelassignments pa ON (
            pa.requirementid = r.requirementid
            OR (r.criteriaid IS NOT NULL AND pa.criteriaid = r.criteriaid)
            OR (c.parentcriteriaid IS NOT NULL AND pa.criteriaid = c.parentcriteriaid)
            OR (COALESCE(c.areaid, pc.areaid) IS NOT NULL AND pa.areaid = COALESCE(c.areaid, pc.areaid))
        )
        WHERE r.requirementid IN (${idPlaceholders})
        ${eventId ? 'AND (pa.eventid = ? OR pa.eventid = 0 OR pa.eventid IS NULL)' : ''}
    `;
    const paParams = eventId ? [...ids, eventId] : [...ids];

    // 3. Office heads assigned to this office
    const ohaPromise = officeIdNum
        ? db.query(
            `SELECT DISTINCT h.userid
             FROM officeheadassignments oha
             JOIN headofoffice h ON oha.headid = h.headid
             WHERE oha.officeid = ? AND h.userid IS NOT NULL`,
            [officeIdNum]
        )
        : Promise.resolve([[]]);

    const [[ruaRows], [paRows], [ohaRows]] = await Promise.all([
        db.query(ruaQuery, ruaParams).catch(() => [[]]),
        db.query(paQuery, paParams).catch(() => [[]]),
        ohaPromise.catch(() => [[]])
    ]);

    const allUserIds = new Set();
    const addUid = (reqId, uid) => {
        const rId = Number(reqId);
        const uId = Number(uid);
        if (!Number.isInteger(uId) || uId <= 0 || !map.has(rId)) return;
        map.get(rId).set(uId, null);
        allUserIds.add(uId);
    };

    for (const r of ruaRows || []) addUid(r.requirementid, r.userid);
    for (const r of paRows || []) addUid(r.requirementid, r.userid);
    for (const r of ohaRows || []) {
        for (const reqId of ids) addUid(reqId, r.userid);
    }

    if (includeUserDetails && allUserIds.size > 0) {
        const uidList = [...allUserIds];
        const uPlaceholders = uidList.map(() => '?').join(',');
        const [userRows] = await db.query(
            `SELECT userid, firstname, middleinitial, lastname, email, profilepic
             FROM users
             WHERE userid IN (${uPlaceholders})`,
            uidList
        );
        const userById = new Map((userRows || []).map(u => [Number(u.userid), u]));
        for (const reqMap of map.values()) {
            for (const uid of reqMap.keys()) {
                reqMap.set(uid, userById.get(uid) || null);
            }
        }
    }

    return map;
}

/**
 * Calculates the aggregated evidence approval rate and per-personnel breakdown
 * for a single standard (optionally scoped to an office/program).
 */
async function calculateStandardCompliance(db, requirementid, officeid = null) {
    const reqIdNum = Number(requirementid);
    const officeIdNum = officeid ? Number(officeid) : null;

    let docQuery = `
        SELECT
            d.uploadedby AS userid,
            SUM(CASE WHEN LOWER(COALESCE(d.reviewstatus, 'pending')) = 'approved' THEN 1 ELSE 0 END) AS approvedcount,
            SUM(CASE WHEN LOWER(COALESCE(d.reviewstatus, 'pending')) = 'pending' THEN 1 ELSE 0 END) AS pendingcount,
            SUM(CASE WHEN LOWER(COALESCE(d.reviewstatus, 'pending')) = 'rejected' THEN 1 ELSE 0 END) AS rejectedcount
        FROM officeproofdocuments d
        WHERE d.requirementid = ?
    `;
    const docParams = [reqIdNum];
    if (officeIdNum) {
        docQuery += ` AND d.officeid = ?`;
        docParams.push(officeIdNum);
    }
    docQuery += ` GROUP BY d.uploadedby`;

    const [[docRows], assignedByReq] = await Promise.all([
        db.query(docQuery, docParams),
        getAssignedPersonnelMap(db, [reqIdNum], officeIdNum, true)
    ]);

    const assignedUsersMap = assignedByReq.get(reqIdNum) || new Map();

    const docByUser = new Map();
    for (const row of docRows || []) {
        const uid = Number(row.userid);
        docByUser.set(uid, {
            approvedCount: Number(row.approvedcount || 0),
            pendingCount: Number(row.pendingcount || 0),
            rejectedCount: Number(row.rejectedcount || 0)
        });
    }

    const personnelMap = new Map();
    for (const [uid, u] of assignedUsersMap.entries()) {
        const counts = docByUser.get(uid) || { approvedCount: 0, pendingCount: 0, rejectedCount: 0 };
        const activeCount = counts.approvedCount + counts.pendingCount;
        const fullname = u ? [u.firstname, u.middleinitial, u.lastname].filter(Boolean).join(' ').trim() : '';
        personnelMap.set(uid, {
            userid: uid,
            fullname: fullname || u?.email || `User #${uid}`,
            email: u?.email || null,
            profilepic: u?.profilepic || null,
            approvedCount: counts.approvedCount,
            pendingCount: counts.pendingCount,
            rejectedCount: counts.rejectedCount,
            activeCount,
            maxSlots: MAX_ACTIVE_EVIDENCE_PER_PERSONNEL
        });
    }

    // Include any uploader who might not be in assignments (e.g. admin)
    const missingUploaderIds = [...docByUser.keys()].filter(uid => !personnelMap.has(uid));
    if (missingUploaderIds.length > 0) {
        const placeholders = missingUploaderIds.map(() => '?').join(',');
        const [extraUsers] = await db.query(
            `SELECT userid, firstname, middleinitial, lastname, email, profilepic FROM users WHERE userid IN (${placeholders})`,
            missingUploaderIds
        );
        const extraMap = new Map((extraUsers || []).map(u => [Number(u.userid), u]));
        for (const uid of missingUploaderIds) {
            const counts = docByUser.get(uid);
            const u = extraMap.get(uid);
            const fullname = u ? [u.firstname, u.middleinitial, u.lastname].filter(Boolean).join(' ').trim() : '';
            personnelMap.set(uid, {
                userid: uid,
                fullname: fullname || u?.email || `User #${uid}`,
                email: u?.email || null,
                profilepic: u?.profilepic || null,
                approvedCount: counts.approvedCount,
                pendingCount: counts.pendingCount,
                rejectedCount: counts.rejectedCount,
                activeCount: counts.approvedCount + counts.pendingCount,
                maxSlots: MAX_ACTIVE_EVIDENCE_PER_PERSONNEL
            });
        }
    }

    let totalApproved = 0;
    let totalPending = 0;
    let totalRejected = 0;
    for (const counts of docByUser.values()) {
        totalApproved += counts.approvedCount;
        totalPending += counts.pendingCount;
        totalRejected += counts.rejectedCount;
    }

    const assignedPersonnelCount = Math.max(assignedUsersMap.size, personnelMap.size);
    const personnelBreakdown = [...personnelMap.values()];

    return buildComplianceSummary(
        totalApproved,
        totalPending,
        totalRejected,
        assignedPersonnelCount,
        personnelBreakdown
    );
}

/**
 * Batch-calculates evidence compliance summaries for multiple standards in an office.
 */
async function calculateBulkStandardCompliance(db, requirementIds, officeid = null) {
    const ids = [...new Set((requirementIds || []).map(Number).filter(n => Number.isInteger(n) && n > 0))];
    const result = new Map();
    if (ids.length === 0) return result;

    const officeIdNum = officeid ? Number(officeid) : null;
    const idPlaceholders = ids.map(() => '?').join(',');

    let docQuery = `
        SELECT
            requirementid,
            SUM(CASE WHEN LOWER(COALESCE(reviewstatus, 'pending')) = 'approved' THEN 1 ELSE 0 END) AS approvedcount,
            SUM(CASE WHEN LOWER(COALESCE(reviewstatus, 'pending')) = 'pending' THEN 1 ELSE 0 END) AS pendingcount,
            SUM(CASE WHEN LOWER(COALESCE(reviewstatus, 'pending')) = 'rejected' THEN 1 ELSE 0 END) AS rejectedcount
        FROM officeproofdocuments
        WHERE requirementid IN (${idPlaceholders})
    `;
    const docParams = [...ids];
    if (officeIdNum) {
        docQuery += ` AND officeid = ?`;
        docParams.push(officeIdNum);
    }
    docQuery += ` GROUP BY requirementid`;

    const [[docRows], assignedByReq] = await Promise.all([
        db.query(docQuery, docParams),
        getAssignedPersonnelMap(db, ids, officeIdNum, false)
    ]);

    const docMap = new Map((docRows || []).map(r => [Number(r.requirementid), r]));

    for (const id of ids) {
        const d = docMap.get(id);
        const assignedCount = assignedByReq.get(id)?.size || 0;
        result.set(
            id,
            buildComplianceSummary(
                d?.approvedcount || 0,
                d?.pendingcount || 0,
                d?.rejectedcount || 0,
                assignedCount
            )
        );
    }

    return result;
}

/**
 * Returns full version & review history for an evidence document.
 */
async function getDocumentHistory(db, documentId) {
    await ensureEvidenceSchema(db);
    const [docRows] = await db.query(
        `SELECT d.*,
                CONCAT(u.firstname, ' ', u.lastname) AS uploadername,
                CONCAT(r.firstname, ' ', r.lastname) AS reviewername
         FROM officeproofdocuments d
         LEFT JOIN users u ON d.uploadedby = u.userid
         LEFT JOIN users r ON d.reviewedby = r.userid
         WHERE d.id = ?
         LIMIT 1`,
        [Number(documentId)]
    );
    if (!docRows || docRows.length === 0) return null;

    const doc = docRows[0];
    await syncInitialVersionIfMissing(db, doc);

    const [versions] = await db.query(
        `SELECT v.id,
                v.documentid,
                v.versionno,
                v.filename,
                v.displayname,
                v.filepath,
                v.comment,
                v.submittedby,
                v.submittedat,
                v.reviewstatus,
                v.rejectionreason,
                v.reviewedby,
                v.reviewedat,
                TRIM(CONCAT(COALESCE(su.firstname, ''), ' ', COALESCE(su.lastname, ''))) AS submittername,
                TRIM(CONCAT(COALESCE(ru.firstname, ''), ' ', COALESCE(ru.lastname, ''))) AS reviewername
         FROM officeproofdocumentversions v
         LEFT JOIN users su ON v.submittedby = su.userid
         LEFT JOIN users ru ON v.reviewedby = ru.userid
         WHERE v.documentid = ?
         ORDER BY v.versionno DESC, v.submittedat DESC`,
        [Number(documentId)]
    );

    return {
        document: {
            id: doc.id,
            requirementid: doc.requirementid,
            officeid: doc.officeid,
            uploadedby: doc.uploadedby,
            uploaderName: doc.uploadername?.trim() || null,
            filename: doc.filename,
            displayname: doc.displayname,
            filepath: doc.filepath,
            currentversion: Number(doc.currentversion || 1),
            reviewstatus: String(doc.reviewstatus || 'pending').toLowerCase(),
            rejectionreason: doc.rejectionreason || null,
            reviewedby: doc.reviewedby || null,
            reviewerName: doc.reviewername?.trim() || null,
            reviewedat: doc.reviewedat || null,
            uploadedat: doc.uploadedat
        },
        versions: (versions || []).map(v => ({
            ...v,
            versionno: Number(v.versionno),
            reviewstatus: String(v.reviewstatus || 'pending').toLowerCase(),
            submitterName: v.submittername || null,
            reviewerName: v.reviewername || null
        }))
    };
}

module.exports = {
    MAX_ACTIVE_EVIDENCE_PER_PERSONNEL,
    ensureEvidenceSchema,
    syncInitialVersionIfMissing,
    getActiveUploadCount,
    calculateStandardCompliance,
    calculateBulkStandardCompliance,
    deriveComplianceStatus,
    syncStandardComplianceStatus,
    getDocumentHistory
};
