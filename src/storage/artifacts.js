import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { inspectPcmWav } from '../wav.js';
import { applyCorrectionDecisions, candidateBundleHash, CRITICAL_CORRECTION_RISKS, transcriptTextHash } from '../tools/correction-integrity.js';
import { hashValue } from '../tools/report-integrity.js';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function writeExclusive(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(file, value, { flag: 'wx' });
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

export class ArtifactStore {
  constructor({ root }) {
    if (!root) throw new TypeError('ArtifactStore root is required');
    this.root = path.resolve(root);
    this.audioRoot = path.join(this.root, 'audio');
    this.transcriptRoot = path.join(this.root, 'transcripts');
    this.correctionRoot = path.join(this.root, 'corrections');
    this.factRoot = path.join(this.root, 'facts');
  }

  async putAudio(buffer) {
    const wav = inspectPcmWav(buffer);
    const digest = sha256(buffer);
    const audioId = `audio_${digest.slice(0, 24)}`;
    const audioPath = path.join(this.audioRoot, `${audioId}.wav`);
    await writeExclusive(audioPath, buffer);
    const metadata = Object.freeze({
      audio_id: audioId,
      source_hash: `sha256:${digest}`,
      bytes: buffer.length,
      wav,
    });
    await writeExclusive(path.join(this.audioRoot, `${audioId}.json`), `${JSON.stringify(metadata, null, 2)}\n`);
    return metadata;
  }

  audioPath(audioId) {
    if (!/^audio_[a-f0-9]{24}$/.test(String(audioId))) {
      throw Object.assign(new Error('Invalid audio_id.'), { code: 'INVALID_AUDIO_ID', status: 400 });
    }
    return path.join(this.audioRoot, `${audioId}.wav`);
  }

  async hasAudio(audioId) {
    try {
      await fs.access(this.audioPath(audioId));
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }

  async readAudioMetadata(audioId) {
    try {
      return JSON.parse(await fs.readFile(path.join(this.audioRoot, `${audioId}.json`), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw Object.assign(new Error('Audio artifact was not found.'), { code: 'AUDIO_NOT_FOUND', status: 404 });
      }
      throw error;
    }
  }

  async getTranscriptByKey(idempotencyKey) {
    if (!idempotencyKey) return null;
    const keyHash = sha256(String(idempotencyKey));
    const indexPath = path.join(this.transcriptRoot, 'by-key', `${keyHash}.json`);
    try {
      const pointer = JSON.parse(await fs.readFile(indexPath, 'utf8'));
      return JSON.parse(await fs.readFile(path.join(this.transcriptRoot, `${pointer.artifact_id}.json`), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async putTranscript(artifact, { idempotencyKey }) {
    const serializedBasis = JSON.stringify({
      ...artifact,
      created_at: undefined,
      artifact_id: undefined,
    });
    const artifactId = `transcript_${sha256(`${serializedBasis}:${crypto.randomUUID()}`).slice(0, 24)}`;
    const immutable = Object.freeze({
      ...artifact,
      artifact_id: artifactId,
      created_at: new Date().toISOString(),
    });
    const artifactPath = path.join(this.transcriptRoot, `${artifactId}.json`);
    const created = await writeExclusive(artifactPath, `${JSON.stringify(immutable, null, 2)}\n`);
    if (!created) throw new Error('Transcript artifact collision.');

    if (idempotencyKey) {
      const keyHash = sha256(String(idempotencyKey));
      const indexPath = path.join(this.transcriptRoot, 'by-key', `${keyHash}.json`);
      const pointerCreated = await writeExclusive(indexPath, `${JSON.stringify({ artifact_id: artifactId })}\n`);
      if (!pointerCreated) {
        const existing = await this.getTranscriptByKey(idempotencyKey);
        await fs.rm(artifactPath, { force: true });
        return existing;
      }
    }
    return immutable;
  }

  async putManualTranscript({ raw_text, language = 'zh' } = {}, { idempotencyKey } = {}) {
    const rawText = String(raw_text || '').trim();
    if (!rawText) {
      throw Object.assign(new Error('Manual transcript text is required.'), { code: 'MANUAL_TEXT_REQUIRED', status: 400 });
    }
    if (rawText.length > 20_000) {
      throw Object.assign(new Error('Manual transcript exceeds 20000 characters.'), { code: 'MANUAL_TEXT_TOO_LARGE', status: 413 });
    }
    return this.putTranscript({
      audio_id: null,
      raw_text: rawText,
      language: String(language || 'zh').slice(0, 20),
      segments: [{ start_ms: 0, end_ms: 0, text: rawText }],
      provider: 'manual',
      model: 'manual-entry',
      source_hash: `sha256:${sha256(Buffer.from(rawText, 'utf8'))}`,
      attempt: 1,
      input_mode: 'MANUAL_TRANSCRIPT',
    }, { idempotencyKey });
  }

  async readTranscript(artifactId) {
    if (!/^transcript_[a-f0-9]{24}$/.test(String(artifactId))) {
      throw Object.assign(new Error('Invalid transcript_artifact_id.'), { code: 'INVALID_TRANSCRIPT_ID', status: 400 });
    }
    try {
      return JSON.parse(await fs.readFile(path.join(this.transcriptRoot, `${artifactId}.json`), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw Object.assign(new Error('Transcript artifact was not found.'), { code: 'TRANSCRIPT_NOT_FOUND', status: 404 });
      }
      throw error;
    }
  }

  validateCorrectionDecisions({ candidates, decisions }) {
    if (!Array.isArray(candidates) || candidates.length > 100 || !Array.isArray(decisions) || decisions.length !== candidates.length) {
      throw Object.assign(new Error('Every server candidate requires exactly one technician decision.'), { code: 'INCOMPLETE_CORRECTION_DECISIONS', status: 400 });
    }
    const candidateMap = new Map(candidates.map((candidate) => [String(candidate?.candidate_id || ''), candidate]));
    if (candidateMap.size !== candidates.length || candidateMap.has('')) {
      throw Object.assign(new Error('Correction candidate IDs must be unique and non-empty.'), { code: 'INVALID_CORRECTION_CANDIDATES', status: 400 });
    }
    const decisionIds = new Set();
    const normalized = decisions.map((decision) => {
      const candidateId = String(decision?.candidate_id || '');
      const candidate = candidateMap.get(candidateId);
      if (!candidate) throw Object.assign(new Error('Decision refers to an unknown correction candidate.'), { code: 'UNKNOWN_CORRECTION_CANDIDATE', status: 400 });
      if (decisionIds.has(candidateId)) throw Object.assign(new Error('Duplicate correction decision.'), { code: 'DUPLICATE_CORRECTION_DECISION', status: 400 });
      decisionIds.add(candidateId);
      const value = String(decision?.decision || '');
      if (!['ACCEPT', 'REJECT'].includes(value)) {
        throw Object.assign(new Error('Correction decision must be ACCEPT or REJECT.'), { code: 'INVALID_CORRECTION_DECISION', status: 400 });
      }
      const criticalConfirmed = decision?.critical_value_confirmed === true;
      if (CRITICAL_CORRECTION_RISKS.has(String(candidate.risk || '')) && !criticalConfirmed) {
        throw Object.assign(new Error('A critical value, negation, measurement, model, refrigerant, completion, or price candidate was not explicitly reviewed.'), { code: 'CRITICAL_CORRECTION_UNCONFIRMED', status: 409 });
      }
      return Object.freeze({
        candidate_id: candidateId,
        decision: value,
        critical_value_confirmed: criticalConfirmed,
      });
    });
    return normalized.sort((a, b) => a.candidate_id.localeCompare(b.candidate_id));
  }

  validateControlledCandidates({ transcript, knowledgeVersion, candidates }) {
    for (const candidate of candidates) {
      const start = Number(candidate?.source_span?.start);
      const end = Number(candidate?.source_span?.end);
      const sourceText = String(candidate?.source_span?.text || '');
      if (!candidate?.candidate_id || candidate.knowledge_version !== knowledgeVersion || !candidate?.match_basis?.rule_id
        || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > transcript.raw_text.length
        || transcript.raw_text.slice(start, end) !== sourceText || !candidate.candidate) {
        throw Object.assign(new Error('Correction candidate is not bound to this transcript and knowledge version.'), { code: 'INVALID_CONTROLLED_CORRECTION_CANDIDATE', status: 409 });
      }
    }
  }

  async putCorrectionReceipt({ transcriptArtifactId, knowledgeVersion, candidates, candidatesHash, decisions, technicianId, technicianName } = {}) {
    const transcript = await this.readTranscript(transcriptArtifactId);
    const version = String(knowledgeVersion || '');
    if (!version) throw Object.assign(new Error('Knowledge version is required.'), { code: 'KNOWLEDGE_VERSION_REQUIRED', status: 400 });
    const controlledCandidates = Array.isArray(candidates) ? candidates : [];
    this.validateControlledCandidates({ transcript, knowledgeVersion: version, candidates: controlledCandidates });
    const expectedCandidatesHash = candidateBundleHash({
      transcriptArtifactId: transcript.artifact_id,
      rawText: transcript.raw_text,
      knowledgeVersion: version,
      candidates: controlledCandidates,
    });
    if (candidatesHash !== expectedCandidatesHash) {
      throw Object.assign(new Error('Candidate bundle hash does not match the server candidate set.'), { code: 'CANDIDATE_BUNDLE_MISMATCH', status: 409 });
    }
    const normalizedDecisions = this.validateCorrectionDecisions({ candidates: controlledCandidates, decisions });
    const finalText = applyCorrectionDecisions(transcript.raw_text, controlledCandidates, normalizedDecisions);
    const id = String(technicianId || '').trim().slice(0, 120);
    const name = String(technicianName || '').trim().slice(0, 120);
    if (!id || !name) throw Object.assign(new Error('Technician ID and name are required for transcript confirmation.'), { code: 'CORRECTION_TECHNICIAN_REQUIRED', status: 400 });
    const candidateMap = new Map(controlledCandidates.map((candidate) => [candidate.candidate_id, candidate]));
    const confirmedAt = new Date().toISOString();
    const core = {
      schema_version: 'hvac-correction-receipt.v1',
      transcript_artifact_id: transcript.artifact_id,
      transcript_raw_text_hash: transcriptTextHash(transcript.raw_text),
      knowledge_version: version,
      candidate_bundle_hash: expectedCandidatesHash,
      candidates: controlledCandidates,
      decisions: normalizedDecisions.map((decision) => {
        const candidate = candidateMap.get(decision.candidate_id);
        return {
          ...decision,
          correction_id: `corr_${candidate.candidate_id}`,
          source_span: candidate.source_span,
          candidate: candidate.candidate,
          knowledge_ids: candidate.knowledge_ids,
          risk: candidate.risk,
          match_basis: candidate.match_basis,
          status: decision.decision === 'ACCEPT' ? 'CONFIRMED_BY_TECHNICIAN' : 'REJECTED_BY_TECHNICIAN',
        };
      }),
      final_text: finalText,
      final_text_hash: transcriptTextHash(finalText),
      technician_id: id,
      technician_name: name,
      confirmed_at: confirmedAt,
    };
    const receiptHash = hashValue(core);
    const receiptId = `correction_${receiptHash.slice(7, 31)}`;
    const receipt = Object.freeze({
      ...core,
      correction_receipt_id: receiptId,
      correction_receipt_hash: receiptHash,
    });
    const file = path.join(this.correctionRoot, `${receiptId}.json`);
    const created = await writeExclusive(file, `${JSON.stringify(receipt, null, 2)}\n`);
    if (!created) {
      const existing = JSON.parse(await fs.readFile(file, 'utf8'));
      if (existing.correction_receipt_hash !== receiptHash) {
        throw Object.assign(new Error('Correction receipt collision.'), { code: 'CORRECTION_RECEIPT_COLLISION', status: 409 });
      }
      return existing;
    }
    return receipt;
  }

  async readCorrectionReceipt(receiptId, { expectedKnowledgeVersion, expectedCandidates, expectedCandidatesHash } = {}) {
    const id = String(receiptId || '');
    if (!/^correction_[a-f0-9]{24}$/.test(id)) {
      throw Object.assign(new Error('A valid correction_receipt_id is required.'), { code: 'INVALID_CORRECTION_RECEIPT_ID', status: 400 });
    }
    try {
      const receipt = JSON.parse(await fs.readFile(path.join(this.correctionRoot, `${id}.json`), 'utf8'));
      const { correction_receipt_id: storedId, correction_receipt_hash: storedHash, ...core } = receipt;
      const calculatedHash = hashValue(core);
      if (storedId !== id || storedHash !== calculatedHash || `correction_${calculatedHash.slice(7, 31)}` !== id) {
        throw Object.assign(new Error('Correction receipt failed its integrity check.'), { code: 'CORRECTION_RECEIPT_TAMPERED', status: 409 });
      }
      const transcript = await this.readTranscript(receipt.transcript_artifact_id);
      if (receipt.transcript_raw_text_hash !== transcriptTextHash(transcript.raw_text)) {
        throw Object.assign(new Error('Correction receipt is bound to a different or changed transcript.'), { code: 'CORRECTION_TRANSCRIPT_MISMATCH', status: 409 });
      }
      const calculatedCandidatesHash = candidateBundleHash({
        transcriptArtifactId: transcript.artifact_id,
        rawText: transcript.raw_text,
        knowledgeVersion: receipt.knowledge_version,
        candidates: receipt.candidates,
      });
      if (calculatedCandidatesHash !== receipt.candidate_bundle_hash) {
        throw Object.assign(new Error('Correction candidate bundle failed its integrity check.'), { code: 'CORRECTION_CANDIDATES_TAMPERED', status: 409 });
      }
      this.validateControlledCandidates({ transcript, knowledgeVersion: receipt.knowledge_version, candidates: receipt.candidates });
      const normalizedDecisions = this.validateCorrectionDecisions({ candidates: receipt.candidates, decisions: receipt.decisions });
      const finalText = applyCorrectionDecisions(transcript.raw_text, receipt.candidates, normalizedDecisions);
      if (receipt.final_text !== finalText || receipt.final_text_hash !== transcriptTextHash(finalText)) {
        throw Object.assign(new Error('Confirmed text failed its integrity check.'), { code: 'CORRECTION_FINAL_TEXT_TAMPERED', status: 409 });
      }
      if (expectedKnowledgeVersion && receipt.knowledge_version !== expectedKnowledgeVersion) {
        throw Object.assign(new Error('Correction receipt knowledge version is stale or inconsistent.'), { code: 'CORRECTION_KNOWLEDGE_VERSION_MISMATCH', status: 409 });
      }
      if (expectedCandidates) {
        const serverHash = candidateBundleHash({
          transcriptArtifactId: transcript.artifact_id,
          rawText: transcript.raw_text,
          knowledgeVersion: expectedKnowledgeVersion || receipt.knowledge_version,
          candidates: expectedCandidates,
        });
        if (serverHash !== receipt.candidate_bundle_hash) {
          throw Object.assign(new Error('Correction receipt does not match the current server candidate set.'), { code: 'CORRECTION_CANDIDATE_SET_MISMATCH', status: 409 });
        }
      }
      if (expectedCandidatesHash && receipt.candidate_bundle_hash !== expectedCandidatesHash) {
        throw Object.assign(new Error('Correction receipt candidate hash does not match.'), { code: 'CORRECTION_CANDIDATE_HASH_MISMATCH', status: 409 });
      }
      return receipt;
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw Object.assign(new Error('Correction receipt was not found.'), { code: 'CORRECTION_RECEIPT_NOT_FOUND', status: 404 });
      }
      throw error;
    }
  }

  async putFacts({ correctionReceipt, facts } = {}) {
    const verifiedCorrection = await this.readCorrectionReceipt(correctionReceipt?.correction_receipt_id);
    if (verifiedCorrection.correction_receipt_hash !== correctionReceipt?.correction_receipt_hash) {
      throw Object.assign(new Error('Facts must bind to the verified correction receipt.'), { code: 'CORRECTION_RECEIPT_MISMATCH', status: 409 });
    }
    if (!Array.isArray(facts) || facts.length > 100) {
      throw Object.assign(new Error('Facts must be an array with at most 100 entries.'), { code: 'INVALID_FACTS', status: 400 });
    }
    const factsHash = `sha256:${sha256(Buffer.from(JSON.stringify(facts), 'utf8'))}`;
    const receiptId = `facts_${sha256(`${verifiedCorrection.correction_receipt_hash}:${factsHash}`).slice(0, 24)}`;
    const file = path.join(this.factRoot, `${receiptId}.json`);
    const receipt = Object.freeze({
      facts_receipt_id: receiptId,
      transcript_artifact_id: verifiedCorrection.transcript_artifact_id,
      correction_receipt_id: verifiedCorrection.correction_receipt_id,
      correction_receipt_hash: verifiedCorrection.correction_receipt_hash,
      confirmed_text_hash: verifiedCorrection.final_text_hash,
      facts_hash: factsHash,
      facts,
      created_at: new Date().toISOString(),
    });
    const created = await writeExclusive(file, `${JSON.stringify(receipt, null, 2)}\n`);
    if (!created) {
      const existing = JSON.parse(await fs.readFile(file, 'utf8'));
      if (existing.correction_receipt_hash !== verifiedCorrection.correction_receipt_hash || existing.facts_hash !== factsHash) {
        throw Object.assign(new Error('Facts receipt collision.'), { code: 'FACTS_RECEIPT_COLLISION', status: 409 });
      }
      return existing;
    }
    return receipt;
  }

  async readFacts(receiptId) {
    const id = String(receiptId || '');
    if (!/^facts_[a-f0-9]{24}$/.test(id)) {
      throw Object.assign(new Error('A valid facts_receipt_id is required.'), { code: 'INVALID_FACTS_RECEIPT_ID', status: 400 });
    }
    try {
      const receipt = JSON.parse(await fs.readFile(path.join(this.factRoot, `${id}.json`), 'utf8'));
      const expectedHash = `sha256:${sha256(Buffer.from(JSON.stringify(receipt.facts), 'utf8'))}`;
      const correction = await this.readCorrectionReceipt(receipt.correction_receipt_id);
      const expectedId = `facts_${sha256(`${correction.correction_receipt_hash}:${expectedHash}`).slice(0, 24)}`;
      if (receipt.facts_receipt_id !== id || receipt.facts_hash !== expectedHash || expectedId !== id) {
        throw Object.assign(new Error('Facts receipt failed its integrity check.'), { code: 'FACTS_RECEIPT_TAMPERED', status: 409 });
      }
      if (receipt.transcript_artifact_id !== correction.transcript_artifact_id
        || receipt.correction_receipt_hash !== correction.correction_receipt_hash
        || receipt.confirmed_text_hash !== correction.final_text_hash) {
        throw Object.assign(new Error('Facts receipt is not bound to its correction receipt.'), { code: 'FACTS_CORRECTION_BINDING_MISMATCH', status: 409 });
      }
      return receipt;
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw Object.assign(new Error('Facts receipt was not found.'), { code: 'FACTS_RECEIPT_NOT_FOUND', status: 404 });
      }
      throw error;
    }
  }
}
