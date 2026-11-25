import React, { useState, useEffect, useCallback, useMemo } from 'react';
import api from '../../utils/api';
import { useLiveRefresh } from '../../utils/liveSync';
import { useToast } from '../UI/Toast';
import SmartUserAvatar from '../UI/SmartUserAvatar';

function formatRelativeTime(dateVal) {
    if (!dateVal) return '';
    const d = new Date(dateVal);
    if (Number.isNaN(d.getTime())) return '';
    const diffSec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
    if (diffSec < 60) return 'Just now';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) return `${diffDay}d`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function getRoleBadgeStyle(roleid) {
    const r = Number(roleid || 0);
    if (r === 1) return 'bg-indigo-100 text-indigo-700 border-indigo-200';
    if (r === 4) return 'bg-purple-100 text-purple-700 border-purple-200';
    return 'bg-slate-200 text-slate-700 border-slate-300';
}

export default function FileCommentsSection({
    requirementid,
    file = null,
    officeId = null,
    currentUser = null,
    viewerRoleId = 0,
    compactCard = false,
    hideWhenEmpty = false,
    noTopBorder = false,
    hideHeader = false,
}) {
    const { toast } = useToast();
    const [comments, setComments] = useState([]);
    const [loading, setLoading] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [draft, setDraft] = useState('');
    const [expanded, setExpanded] = useState(true);

    const isRequirementMode = !file?.id && Boolean(officeId);

    const effectiveUser = useMemo(() => {
        if (currentUser) return currentUser;
        try {
            const raw = localStorage.getItem('user');
            return raw ? JSON.parse(raw) : null;
        } catch {
            return null;
        }
    }, [currentUser]);

    const effectiveRoleId = Number(viewerRoleId || effectiveUser?.roleid || 0);
    const reviewStatus = String(file?.reviewstatus || 'pending').toLowerCase();
    const isAdmin = effectiveRoleId === 1;
    const isAuditor = effectiveRoleId === 4;
    // File mode: ONLY External Auditor can comment (and only on approved files).
    // Requirement mode: Admin or External Auditor can comment on the requirement.
    const canComment = isRequirementMode
        ? (isAdmin || isAuditor)
        : (isAuditor && reviewStatus === 'approved');
    const canViewComments = isRequirementMode
        ? Boolean(requirementid && officeId)
        : (Boolean(file?.id && requirementid) && (!isAuditor || reviewStatus === 'approved'));

    const fetchComments = useCallback(async () => {
        if (!canViewComments) return;
        setLoading(true);
        try {
            const url = isRequirementMode
                ? `/api/requirements/${requirementid}/comments?officeid=${officeId}`
                : `/api/requirements/${requirementid}/file/${file.id}/comments`;
            const res = await api.get(url);
            if (res.data?.success && Array.isArray(res.data.comments)) {
                setComments(res.data.comments);
            }
        } catch (err) {
            // Silently ignore 403/404 when target isn't accessible
        } finally {
            setLoading(false);
        }
    }, [canViewComments, isRequirementMode, requirementid, officeId, file?.id]);

    useEffect(() => {
        fetchComments();
    }, [fetchComments]);

    useLiveRefresh(fetchComments, {
        entityTypes: ['requirements', 'all'],
        deps: [requirementid, officeId, file?.id, canViewComments],
    });

    const handleSubmit = async (e) => {
        e?.preventDefault?.();
        const text = draft.trim();
        if (!text || !canComment || submitting || !requirementid || (!isRequirementMode && !file?.id)) return;

        setSubmitting(true);
        try {
            const url = isRequirementMode
                ? `/api/requirements/${requirementid}/comments`
                : `/api/requirements/${requirementid}/file/${file.id}/comments`;
            const payload = isRequirementMode
                ? { officeid: Number(officeId), comment: text }
                : { comment: text };
            const res = await api.post(url, payload);
            if (res.data?.success && res.data.comment) {
                setComments((prev) => [...prev, res.data.comment]);
                setDraft('');
                setExpanded(true);
            } else {
                toast?.({
                    title: 'Comment Failed',
                    description: res.data?.message || 'Unable to post comment.',
                    variant: 'error',
                });
            }
        } catch (err) {
            toast?.({
                title: 'Comment Failed',
                description: err.response?.data?.message || err.message || 'Unable to post comment.',
                variant: 'error',
            });
        } finally {
            setSubmitting(false);
        }
    };

    const handleDelete = async (commentId) => {
        if (!requirementid || !commentId || (!isRequirementMode && !file?.id)) return;
        try {
            const url = isRequirementMode
                ? `/api/requirements/${requirementid}/comments/${commentId}`
                : `/api/requirements/${requirementid}/file/${file.id}/comments/${commentId}`;
            const res = await api.delete(url);
            if (res.data?.success) {
                setComments((prev) => prev.filter((c) => c.id !== commentId));
            }
        } catch (err) {
            toast?.({
                title: 'Delete Failed',
                description: err.response?.data?.message || 'Unable to delete comment.',
                variant: 'error',
            });
        }
    };

    if (!canViewComments) return null;
    if (hideWhenEmpty && !loading && comments.length === 0 && !canComment) return null;

    const myName = [effectiveUser?.firstname, effectiveUser?.lastname].filter(Boolean).join(' ').trim() || 'You';

    return (
        <div
            className={noTopBorder ? '' : 'mt-2 pt-2 border-t border-slate-100'}
            onClick={(e) => e.stopPropagation()}
        >
            {!hideHeader && (
                <div className={`flex items-center justify-between ${compactCard ? 'mb-1.5' : 'mb-2'}`}>
                    <button
                        type="button"
                        onClick={() => setExpanded((prev) => !prev)}
                        className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-slate-600 hover:text-slate-900 cursor-pointer"
                    >
                        <svg className="w-3.5 h-3.5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
                        </svg>
                        <span>Comments</span>
                        <span className="rounded-full bg-slate-100 px-1.5 py-0.2 text-[10px] font-bold text-slate-600 border border-slate-200">
                            {comments.length}
                        </span>
                    </button>
                    {comments.length > 0 && (
                        <button
                            type="button"
                            onClick={() => setExpanded((prev) => !prev)}
                            className="text-[10px] font-medium text-blue-600 hover:underline cursor-pointer"
                        >
                            {expanded ? 'Hide' : 'Show'}
                        </button>
                    )}
                </div>
            )}

            {expanded && (
                <div className="space-y-2">
                    {loading && comments.length === 0 ? (
                        <div className={`${compactCard ? 'min-h-[54px] rounded-lg border border-dashed border-slate-200 bg-slate-50/70 px-3 py-2 flex items-center text-[11px] text-slate-400' : 'text-[11px] text-slate-400 py-1'}`}>
                            Loading comments...
                        </div>
                    ) : comments.length === 0 ? (
                        <div className={`${compactCard ? 'min-h-[54px] rounded-lg border border-dashed border-slate-200 bg-slate-50/70 px-3 py-2 flex items-center gap-2 text-[11px] text-slate-400 italic' : 'text-[11px] text-slate-400 italic py-0.5'}`}>
                            {isRequirementMode ? 'No comments yet.' : 'No auditor comments yet.'}
                        </div>
                    ) : (
                        <div className={`space-y-2 overflow-y-auto pr-1 ${compactCard ? 'min-h-[54px] max-h-[84px]' : 'max-h-52'}`}>
                            {comments.map((c) => {
                                const canDelete = isAdmin || Number(c.userid) === Number(effectiveUser?.userid);
                                const fullTimestamp = c.createdat ? new Date(c.createdat).toLocaleString() : '';
                                return (
                                    <div key={c.id} className="flex items-start gap-2 group">
                                        <SmartUserAvatar
                                            user={{ userid: c.userid, profilepic: c.profilepic, full_name: c.fullName }}
                                            fullName={c.fullName}
                                            size="h-7 w-7"
                                            textSize="text-[10px]"
                                            className="mt-0.5"
                                        />
                                        <div className="min-w-0 flex-1">
                                            <div className="inline-block max-w-full rounded-2xl bg-slate-100/95 px-3 py-1.5 border border-slate-200/70">
                                                <div className="flex items-center gap-1.5 flex-wrap">
                                                    <span className="text-[11px] font-bold text-slate-900 leading-tight">
                                                        {c.fullName}
                                                    </span>
                                                    <span className={`inline-flex items-center rounded-full border px-1.5 py-0 text-[9px] font-semibold leading-4 ${getRoleBadgeStyle(c.roleid)}`}>
                                                        {c.roleLabel}
                                                    </span>
                                                </div>
                                                <p className="mt-0.5 text-xs text-slate-800 whitespace-pre-wrap break-words leading-snug">
                                                    {c.comment}
                                                </p>
                                            </div>
                                            <div className="mt-0.5 pl-2 flex items-center gap-3 text-[10px] font-medium text-slate-400">
                                                <span title={fullTimestamp}>{formatRelativeTime(c.createdat)}</span>
                                                {canDelete && (
                                                    <button
                                                        type="button"
                                                        onClick={() => handleDelete(c.id)}
                                                        className="text-slate-400 hover:text-rose-600 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                                                    >
                                                        Delete
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    {canComment && (
                        <form onSubmit={handleSubmit} className="flex items-start gap-2 pt-1">
                            <SmartUserAvatar
                                user={effectiveUser}
                                fullName={myName}
                                size="h-7 w-7"
                                textSize="text-[10px]"
                                className="mt-0.5"
                            />
                            <div className="flex-1 flex items-center gap-1.5 rounded-2xl bg-slate-100 border border-slate-200/90 px-3 py-1.5 focus-within:border-blue-400 focus-within:bg-white transition-colors">
                                <textarea
                                    rows={1}
                                    value={draft}
                                    onChange={(e) => setDraft(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter' && !e.shiftKey) {
                                            e.preventDefault();
                                            handleSubmit();
                                        }
                                    }}
                                    placeholder={isAuditor ? 'Write an auditor comment on this approved file...' : 'Write a comment...'}
                                    disabled={submitting}
                                    className="w-full resize-none bg-transparent text-xs text-slate-800 placeholder:text-slate-400 focus:outline-none leading-snug"
                                />
                                <button
                                    type="submit"
                                    disabled={submitting || !draft.trim()}
                                    className="shrink-0 flex h-6 w-6 items-center justify-center rounded-full bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
                                    title="Send comment"
                                >
                                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M12 5l7 7-7 7" />
                                    </svg>
                                </button>
                            </div>
                        </form>
                    )}
                </div>
            )}
        </div>
    );
}
