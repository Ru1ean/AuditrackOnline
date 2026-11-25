import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import api, { API_BASE_URL } from '../../utils/api';

const STATUS_STYLES = {
    approved: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    rejected: 'bg-rose-50 text-rose-700 border-rose-200',
    pending: 'bg-amber-50 text-amber-700 border-amber-200',
};

const STATUS_LABELS = {
    approved: 'Approved',
    rejected: 'Rejected',
    pending: 'Pending Review',
};

function formatDateTime(val) {
    if (!val) return '—';
    const d = new Date(val);
    if (Number.isNaN(d.getTime())) return String(val);
    return d.toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}

function resolveFileHref(filepath) {
    if (!filepath) return null;
    if (/^https?:\/\//i.test(filepath)) return filepath;
    return `${API_BASE_URL}${filepath.startsWith('/') ? '' : '/'}${filepath}`;
}

export default function EvidenceHistoryModal({
    show,
    onClose,
    requirementid,
    file,
}) {
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [historyData, setHistoryData] = useState(null);

    useEffect(() => {
        if (!show || !requirementid || !file?.id) {
            setHistoryData(null);
            setError(null);
            return;
        }
        let cancelled = false;
        setLoading(true);
        setError(null);
        api.get(`/api/requirements/${requirementid}/file/${file.id}/history`)
            .then((res) => {
                if (cancelled) return;
                if (res.data?.success) {
                    setHistoryData(res.data);
                } else {
                    setError(res.data?.message || 'Failed to load submission history.');
                }
            })
            .catch((err) => {
                if (cancelled) return;
                setError(err.response?.data?.message || err.message || 'Failed to load submission history.');
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [show, requirementid, file?.id]);

    if (!show) return null;

    const doc = historyData?.document || file || {};
    const versions = historyData?.versions || [];
    const docStatus = String(doc.reviewstatus || 'pending').toLowerCase();

    return createPortal(
        <div
            className="fixed inset-0 z-[100020] flex items-center justify-center bg-slate-900/55 backdrop-blur-xs p-4"
            onClick={(e) => {
                e.stopPropagation();
                onClose?.();
            }}
        >
            <div
                className="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-200 bg-slate-50/70">
                    <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                            <h3 className="text-base font-bold text-slate-900 truncate">
                                Evidence Submission History
                            </h3>
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold border ${STATUS_STYLES[docStatus] || STATUS_STYLES.pending}`}>
                                {STATUS_LABELS[docStatus] || 'Pending Review'}
                            </span>
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-slate-100 text-slate-700 border border-slate-200">
                                Current: v{doc.currentversion || 1}
                            </span>
                        </div>
                        <p className="mt-1 text-xs text-slate-600 truncate">
                            {doc.displayname || doc.filename || 'Evidence Document'}
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 hover:bg-slate-100 hover:text-slate-700 cursor-pointer"
                        aria-label="Close history modal"
                    >
                        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto p-5 space-y-4">
                    {loading && (
                        <div className="py-10 text-center text-sm text-slate-500">
                            Loading version history...
                        </div>
                    )}

                    {!loading && error && (
                        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                            {error}
                        </div>
                    )}

                    {!loading && !error && (versions.length === 0 || (versions.length === 1 && Number(doc.currentversion || 1) <= 1)) && (
                        <div className="py-10 text-center text-sm text-slate-500">
                            No revision history yet — this is the initial upload (v1).
                        </div>
                    )}

                    {!loading && !error && (versions.length > 1 || Number(doc.currentversion || 1) > 1) && (
                        <div className="space-y-3">
                            {versions.map((ver, index) => {
                                const verStatus = String(ver.reviewstatus || 'pending').toLowerCase();
                                const href = resolveFileHref(ver.filepath);
                                const isCurrent = Number(ver.versionno) === Number(doc.currentversion || 1) && index === 0;
                                return (
                                    <div
                                        key={ver.id || `v-${ver.versionno}`}
                                        className={`rounded-xl border p-4 transition-colors ${isCurrent ? 'border-blue-200 bg-blue-50/30' : 'border-slate-200 bg-white'}`}
                                    >
                                        <div className="flex flex-wrap items-center justify-between gap-2">
                                            <div className="flex items-center gap-2">
                                                <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-bold bg-slate-800 text-white">
                                                    v{ver.versionno}
                                                </span>
                                                {isCurrent && (
                                                    <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold bg-blue-100 text-blue-700">
                                                        Latest Version
                                                    </span>
                                                )}
                                                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold border ${STATUS_STYLES[verStatus] || STATUS_STYLES.pending}`}>
                                                    {STATUS_LABELS[verStatus] || 'Pending Review'}
                                                </span>
                                            </div>
                                            {href && (
                                                <a
                                                    href={href}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-blue-600 hover:bg-blue-50"
                                                >
                                                    <span>Open File</span>
                                                </a>
                                            )}
                                        </div>

                                        <div className="mt-2.5 grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-slate-600">
                                            <div>
                                                <span className="font-semibold text-slate-700">File:</span>{' '}
                                                <span className="break-all">{ver.displayname || ver.filename}</span>
                                            </div>
                                            <div>
                                                <span className="font-semibold text-slate-700">Submitted:</span>{' '}
                                                {formatDateTime(ver.submittedat)}
                                                {ver.submitterName ? ` by ${ver.submitterName}` : ''}
                                            </div>
                                            {(ver.reviewedat || ver.reviewerName) && (
                                                <div className="sm:col-span-2">
                                                    <span className="font-semibold text-slate-700">Reviewed:</span>{' '}
                                                    {formatDateTime(ver.reviewedat)}
                                                    {ver.reviewerName ? ` by ${ver.reviewerName}` : ''}
                                                </div>
                                            )}
                                        </div>

                                        {ver.comment && (
                                            <div className="mt-2 rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 text-xs text-slate-700">
                                                <span className="font-semibold">Note:</span> {ver.comment}
                                            </div>
                                        )}

                                        {verStatus === 'rejected' && ver.rejectionreason && (
                                            <div className="mt-2 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-xs text-rose-800">
                                                <span className="font-semibold">Rejection Feedback:</span> {ver.rejectionreason}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>
        </div>,
        document.body
    );
}
