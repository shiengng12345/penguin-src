export { createNote, createIncident, appendNote, writeNoteBody, readNote, listNotes, reindexNotesDir, noteSlug, type NoteType } from "./notes-fs.js";
export { computeEvidenceHashes, mergeEvidenceDocument, renderEvidenceMarkdown, upsertEvidenceNote, type EvidenceTarget, type TargetEvidencePacket, type EvidenceCaptureResult, type EvidenceDocument } from "./evidence.js";
export { listEvidenceNotes, setEvidenceStatus, evidenceDoctor, repairEvidence, type EvidenceFileSummary, type EvidenceLifecycle, type EvidenceDoctorReport } from "./notes-fs.js";
