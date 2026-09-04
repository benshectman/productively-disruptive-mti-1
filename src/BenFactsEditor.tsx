import { useEffect, useMemo, useRef, useState } from "react";
import reviewJson from "./content/review/ben-facts-review.v1.json";
import { BenFactsReviewCorpusSchema, type BenFactReview, type BenFactsReviewCorpus, type ReviewStatus } from "./shared/benfacts-review";
import { applyCareerContextDefaults, careerContexts, validateCareerPeriod } from "./shared/benfacts-career-context";
import { filterBenFacts, reconcileCurrentFactId, type BenFactsFilters } from "./shared/benfacts-navigation";
import { similarFacts } from "./shared/benfacts-similarity";
import type { TopicId } from "./shared/contracts";

const endpoint = "/.netlify/functions/benfacts-review";
const initialCorpus = applyCareerContextDefaults(BenFactsReviewCorpusSchema.parse(reviewJson));
const topicLabels: Record<TopicId, string> = {
  "T-001": "Design Leadership",
  "T-002": "Systems Thinking",
  "T-003": "Enterprise UX",
  "T-004": "UX Measurement"
};
const attributionLabels = {
  personal: "Personal",
  leadership: "Leadership",
  team: "Team",
  shared_leadership: "Shared leadership",
  organization: "Organization"
} as const;
type EditableFact = Pick<BenFactReview, "reviewed_text" | "attribution" | "topics" | "project_id" | "career_context_id" | "period" | "visibility">;
type Filters = BenFactsFilters;
const defaultFilters: Filters = { status: "unreviewed", topic: "all", project: "all", attribution: "all", origin: "all" };

function editableFrom(record: BenFactReview): EditableFact {
  return {
    reviewed_text: record.reviewed_text,
    attribution: record.attribution,
    topics: record.topics,
    project_id: record.project_id,
    career_context_id: record.career_context_id,
    period: record.period,
    visibility: record.visibility
  };
}

function draftKey(id: string) { return `benfacts-editor:draft:${id}`; }

function readDraft(record: BenFactReview): EditableFact {
  try {
    const stored = localStorage.getItem(draftKey(record.candidate_id));
    return stored ? { ...editableFrom(record), ...JSON.parse(stored) } : editableFrom(record);
  } catch { return editableFrom(record); }
}

function sourceLabel(source: BenFactReview["source_refs"][number]) {
  const locations = source.locations.map((location) => `${location.kind}${location.number ? ` ${location.number}` : location.label ? ` ${location.label}` : ""}`).join(", ");
  return locations ? `${source.source_id}, ${locations}` : source.source_id;
}

function withPeriodYear(draft: EditableFact, field: "start_year" | "end_year", rawValue: string): EditableFact {
  const value = rawValue === "" ? undefined : Number(rawValue);
  const period = { ...draft.period, [field]: value };
  const nextPeriod = period.start_year === undefined && period.end_year === undefined ? undefined : period;
  return { ...draft, period: nextPeriod };
}

export function BenFactsEditor() {
  const [corpus, setCorpus] = useState<BenFactsReviewCorpus>(initialCorpus);
  const [sha, setSha] = useState<string | null>(null);
  const [currentId, setCurrentId] = useState(initialCorpus.candidates[0].candidate_id);
  const [draft, setDraft] = useState<EditableFact>(() => readDraft(initialCorpus.candidates[0]));
  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ kind: "info" | "error"; message: string } | null>(null);
  const [jumpId, setJumpId] = useState("");
  const titleRef = useRef<HTMLHeadingElement>(null);

  const current = corpus.candidates.find((item) => item.candidate_id === currentId) ?? corpus.candidates[0];
  const projects = useMemo(() => [...new Set(corpus.candidates.map((item) => item.project_id).filter((value): value is string => Boolean(value)))].sort(), [corpus]);
  const filtered = useMemo(() => filterBenFacts(corpus.candidates, filters), [corpus, filters]);
  const currentIndex = filtered.findIndex((item) => item.candidate_id === currentId);
  const counts = useMemo(() => corpus.candidates.reduce((totals, item) => ({ ...totals, [item.review_status]: totals[item.review_status] + 1 }), { unreviewed: 0, approved: 0, hold: 0, rejected: 0 }), [corpus]);
  const reviewedCount = corpus.candidates.length - counts.unreviewed;
  const related = useMemo(() => similarFacts({ ...current, ...draft }, corpus.candidates), [current, draft, corpus]);
  const changed = JSON.stringify(editableFrom(current)) !== JSON.stringify(draft);

  useEffect(() => {
    let active = true;
    fetch(endpoint).then(async (response) => {
      if (!response.ok) throw new Error("The committed review corpus could not be loaded. Showing the bundled copy.");
      return response.json();
    }).then((payload) => {
      if (!active) return;
      const loaded = applyCareerContextDefaults(BenFactsReviewCorpusSchema.parse(payload.corpus));
      setCorpus(loaded); setSha(payload.sha); setCurrentId((id) => loaded.candidates.some((item) => item.candidate_id === id) ? id : loaded.candidates[0].candidate_id);
      setNotice({ kind: "info", message: `Reviewing ${payload.branch}` });
    }).catch((error) => active && setNotice({ kind: "error", message: error instanceof Error ? error.message : "Could not load the committed review corpus." }));
    return () => { active = false; };
  }, []);

  useEffect(() => { setDraft(readDraft(current)); }, [currentId, current]);
  useEffect(() => {
    const reconciledId = reconcileCurrentFactId(currentId, filtered);
    if (reconciledId === currentId) return;
    if (changed) localStorage.setItem(draftKey(current.candidate_id), JSON.stringify(draft));
    setCurrentId(reconciledId);
    window.scrollTo({ top: 0, behavior: "smooth" });
    window.setTimeout(() => titleRef.current?.focus(), 0);
  }, [changed, current.candidate_id, currentId, draft, filtered]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (changed) localStorage.setItem(draftKey(current.candidate_id), JSON.stringify(draft));
      else localStorage.removeItem(draftKey(current.candidate_id));
    }, 350);
    return () => window.clearTimeout(timer);
  }, [current.candidate_id, draft, changed]);

  function navigate(id: string) {
    if (!corpus.candidates.some((item) => item.candidate_id === id)) return;
    setCurrentId(id); setNotice(null); window.scrollTo({ top: 0, behavior: "smooth" });
    window.setTimeout(() => titleRef.current?.focus(), 0);
  }

  function move(offset: number) {
    if (!filtered.length) return;
    const index = currentIndex < 0 ? 0 : Math.min(filtered.length - 1, Math.max(0, currentIndex + offset));
    navigate(filtered[index].candidate_id);
  }

  async function disposition(review_status: Exclude<ReviewStatus, "unreviewed">) {
    if (!draft.reviewed_text.trim()) { setNotice({ kind: "error", message: "Fact wording cannot be empty." }); return; }
    const periodError = validateCareerPeriod(draft);
    if (periodError) { setNotice({ kind: "error", message: periodError }); return; }
    if (!sha) { setNotice({ kind: "error", message: "GitHub persistence is unavailable. Your edit remains saved locally." }); return; }
    const reviewed: BenFactReview = { ...current, ...draft, reviewed_text: draft.reviewed_text.trim(), review_status, reviewed_at: new Date().toISOString() };
    const nextCorpus = { ...corpus, candidates: corpus.candidates.map((item) => item.candidate_id === current.candidate_id ? reviewed : item) };
    setSaving(true); setNotice(null);
    try {
      const response = await fetch(endpoint, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ corpus: nextCorpus, expectedSha: sha, candidateId: current.candidate_id }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not save to GitHub.");
      setCorpus(nextCorpus); setSha(payload.sha); localStorage.removeItem(draftKey(current.candidate_id));
      const next = nextCorpus.candidates.find((item) => item.review_status === "unreviewed" && item.candidate_id !== current.candidate_id);
      if (next) navigate(next.candidate_id);
      else setNotice({ kind: "info", message: "All candidates have a review disposition." });
    } catch (error) {
      localStorage.setItem(draftKey(current.candidate_id), JSON.stringify(draft));
      setNotice({ kind: "error", message: `${error instanceof Error ? error.message : "Could not save to GitHub."} Your edit is still preserved locally.` });
    } finally { setSaving(false); }
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable || event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "a") disposition("approved");
      if (key === "h") disposition("hold");
      if (key === "r") disposition("rejected");
      if (key === "j") move(1);
      if (key === "k") move(-1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  function jump(event: React.FormEvent) {
    event.preventDefault();
    const match = corpus.candidates.find((item) => item.candidate_id.toLowerCase() === jumpId.trim().toLowerCase());
    if (match) { navigate(match.candidate_id); setJumpId(""); }
    else setNotice({ kind: "error", message: `No candidate matches “${jumpId.trim()}”.` });
  }

  return <main className="benfacts-editor" id="main-content">
    <header className="editor-topbar">
      <div><p className="editor-kicker">Productively Disruptive · Internal</p><h1>BenFacts Editor</h1></div>
      <div className="editor-progress" aria-label={`${reviewedCount} reviewed, ${counts.unreviewed} remaining`}><strong>{reviewedCount}</strong> reviewed <span>·</span> <strong>{counts.unreviewed}</strong> remaining</div>
    </header>

    <section className="editor-summary" aria-label="Review summary">
      <span><b>{corpus.candidates.length}</b> candidates</span><span><b>{counts.approved}</b> approved</span><span><b>{counts.hold}</b> hold</span><span><b>{counts.rejected}</b> rejected</span><span><b>{counts.unreviewed}</b> unreviewed</span>
    </section>

    <section className="editor-filters" aria-label="Review filters">
      <label>Status<select value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value as Filters["status"] })}><option value="unreviewed">Unreviewed</option><option value="approved">Approved</option><option value="hold">Hold</option><option value="rejected">Rejected</option><option value="all">All</option></select></label>
      <label>Topic<select value={filters.topic} onChange={(event) => setFilters({ ...filters, topic: event.target.value as Filters["topic"] })}><option value="all">All topics</option>{Object.entries(topicLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      <label>Project<select value={filters.project} onChange={(event) => setFilters({ ...filters, project: event.target.value })}><option value="all">All projects</option><option value="none">No project</option>{projects.map((project) => <option key={project}>{project}</option>)}</select></label>
      <label>Attribution<select value={filters.attribution} onChange={(event) => setFilters({ ...filters, attribution: event.target.value as Filters["attribution"] })}><option value="all">All attribution</option>{Object.entries(attributionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>Origin<select value={filters.origin} onChange={(event) => setFilters({ ...filters, origin: event.target.value as Filters["origin"] })}><option value="all">All origins</option><option value="baseline">Baseline</option><option value="expansion">Expansion</option></select></label>
      <button type="button" className="editor-clear" onClick={() => setFilters(defaultFilters)}>Reset</button>
    </section>

    {notice && <div className={`editor-notice ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.message}</div>}

    <div className="editor-layout">
      <article className="fact-workspace">
        <div className="fact-heading">
          <div><p className="editor-kicker">Candidate</p><h2 ref={titleRef} tabIndex={-1}>{current.candidate_id}</h2></div>
          <span className={`status-badge status-${current.review_status}`}>{current.review_status}</span>
        </div>

        <label className="fact-text">Fact wording<textarea rows={7} value={draft.reviewed_text} onChange={(event) => setDraft({ ...draft, reviewed_text: event.target.value })}/></label>
        {draft.reviewed_text !== current.original_text && <details className="original-wording"><summary>Original candidate wording</summary><p>{current.original_text}</p></details>}

        <div className="metadata-grid">
          <label>Attribution<select value={draft.attribution} onChange={(event) => setDraft({ ...draft, attribution: event.target.value as BenFactReview["attribution"] })}>{Object.entries(attributionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>Project<select value={draft.project_id ?? ""} onChange={(event) => setDraft({ ...draft, project_id: event.target.value || undefined })}><option value="">No project</option>{projects.map((project) => <option key={project}>{project}</option>)}</select></label>
          <label>Visibility<select value={draft.visibility} onChange={(event) => setDraft({ ...draft, visibility: event.target.value as BenFactReview["visibility"] })}><option value="shareable">Shareable</option><option value="knowledge_only">Knowledge only</option></select></label>
          <label>Career context<select value={draft.career_context_id ?? ""} onChange={(event) => setDraft({ ...draft, career_context_id: event.target.value || undefined, ...(event.target.value ? {} : { period: undefined }) })}><option value="">No single career context</option>{careerContexts.map((context) => <option key={context.id} value={context.id}>{context.display_name} · {context.start_year}–{context.end_year}</option>)}</select></label>
          <label>Specific period start<input type="number" min="1900" max="2100" value={draft.period?.start_year ?? ""} onChange={(event) => setDraft(withPeriodYear(draft, "start_year", event.target.value))} placeholder="Optional"/></label>
          <label>Specific period end<input type="number" min="1900" max="2100" value={draft.period?.end_year ?? ""} onChange={(event) => setDraft(withPeriodYear(draft, "end_year", event.target.value))} placeholder="Optional"/></label>
        </div>

        <fieldset className="topic-fieldset"><legend>Topics</legend><div className="topic-checks">{Object.entries(topicLabels).map(([id, label]) => <label key={id}><input type="checkbox" checked={draft.topics.includes(id as TopicId)} onChange={(event) => setDraft({ ...draft, topics: event.target.checked ? [...draft.topics, id as TopicId] : draft.topics.filter((topic) => topic !== id) })}/><span>{label}</span></label>)}</div></fieldset>

        <section className="provenance" aria-labelledby="provenance-title"><h3 id="provenance-title">Provenance</h3><dl>
          <div><dt>Origin</dt><dd>{current.origin}</dd></div>
          <div><dt>Evidence strength</dt><dd>{current.evidence_strength || "Not specified"}</dd></div>
          <div><dt>Source references</dt><dd>{current.source_refs.length ? <ul>{current.source_refs.map((source) => <li key={source.source_id}>{sourceLabel(source)}</li>)}</ul> : "None recorded"}</dd></div>
          {current.review_notes && <div><dt>Review notes</dt><dd>{current.review_notes}</dd></div>}
          {Boolean(current.overlap_review) && <div><dt>Overlap review</dt><dd><pre>{JSON.stringify(current.overlap_review, null, 2)}</pre></dd></div>}
          {Boolean(current.lineage) && <div><dt>Lineage</dt><dd><pre>{JSON.stringify(current.lineage, null, 2)}</pre></dd></div>}
        </dl></section>

        <div className="decision-bar">
          <div><button type="button" className="reject" disabled={saving} onClick={() => disposition("rejected")}>Reject <kbd>R</kbd></button><button type="button" className="hold" disabled={saving} onClick={() => disposition("hold")}>Hold <kbd>H</kbd></button></div>
          <button type="button" className="approve" disabled={saving} onClick={() => disposition("approved")}>{saving ? "Saving…" : "Approve"} <kbd>A</kbd></button>
        </div>
        <p className="draft-state" aria-live="polite">{changed ? "Draft saved locally until you choose a disposition." : "No unsaved edits."}</p>
      </article>

      <aside className="review-sidebar">
        <section className="similar-items"><h3>Similar items</h3>{related.length ? <ol>{related.map((item) => <li key={item.candidate_id}><button type="button" onClick={() => navigate(item.candidate_id)}><span><b>{item.candidate_id}</b><i>{item.review_status}</i></span>{item.reviewed_text}</button></li>)}</ol> : <p>No related items found.</p>}</section>
        <section className="navigation-panel"><h3>Navigate</h3><div className="previous-next"><button type="button" disabled={currentIndex <= 0} onClick={() => move(-1)}>← Previous <kbd>K</kbd></button><button type="button" disabled={currentIndex < 0 || currentIndex >= filtered.length - 1} onClick={() => move(1)}>Next <kbd>J</kbd> →</button></div><p>{currentIndex >= 0 ? `${currentIndex + 1} of ${filtered.length} in this view` : `${filtered.length} facts match these filters`}</p><form onSubmit={jump}><label>Jump to fact ID<input value={jumpId} onChange={(event) => setJumpId(event.target.value)} placeholder="BF-C-047"/></label><button type="submit">Go</button></form></section>
      </aside>
    </div>
  </main>;
}