import { useMemo, useState } from "react";
import { Card } from "@astryxdesign/core/Card";
import { Carousel } from "@astryxdesign/core/Carousel";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { contentPacket } from "./content/content";
import { assembleNarrative, buildDeepDiveNarrative } from "./shared/narrative";
import { GenerateResponseSchema, type Narrative, type PublicEvidence, type TopicId, type VisitorContext } from "./shared/contracts";
import { approvedEvidenceCatalog, buildEvidencePresentation, evidencePointsLabel, type EvidencePresentation } from "./shared/evidence-presentation";

const endpoint = import.meta.env.VITE_GENERATE_ENDPOINT || "/.netlify/functions/generate";
const activity = [
  "Matching your interests to Ben’s experience",
  "Selecting the strongest supporting evidence",
  "Shaping your narrative",
  "Building your experience with Astryx"
];

function Configurator({ context, onTopics, onGenerate }: {
  context: VisitorContext;
  onTopics: (topics: TopicId[]) => void;
  onGenerate: () => void;
}) {
  const toggle = (id: TopicId) => onTopics(context.topics.includes(id)
    ? context.topics.filter((topic) => topic !== id) as TopicId[]
    : [...context.topics, id]);
  return (
    <main className="landing" id="main-content">
      <div className="portrait" role="img" aria-label="Ben Shectman headshot placeholder"><span>BS</span></div>
      <section className="intro" aria-labelledby="intro-title">
        <p className="kicker">Productively Disruptive · A generative portfolio</p>
        <h1 id="intro-title">Ben Shectman</h1>
        <p className="headline">I craft the structure <em>&amp;</em> circumstances for design teams to thrive.</p>
        <p className="orientation">Shape this portfolio around what matters to you.</p>
      </section>
      <section className="configuration" aria-labelledby="configure-title">
        <h2 id="configure-title">Configure your experience</h2>
        <div className="fixed-controls">
          <label>Design system<select value="astryx" disabled><option value="astryx">Astryx</option></select></label>
          <label>Theme<select value="neutral" disabled><option value="neutral">Neutral</option></select></label>
        </div>
        <fieldset>
          <legend>Topics <span>Optional · choose any</span></legend>
          <div className="topics">
            {contentPacket.topics.map((topic) => {
              const selected = context.topics.includes(topic.id as TopicId);
              return <button key={topic.id} type="button" className="topic" aria-pressed={selected} onClick={() => toggle(topic.id as TopicId)}>{topic.label}</button>;
            })}
          </div>
        </fieldset>
        <button className="generate" type="button" onClick={onGenerate}>Generate my experience <span aria-hidden="true">↗</span></button>
        <p className="grounding-note">AI shapes the framing, never the underlying facts. Validation builds may use clearly labeled, unapproved candidate BenFacts.</p>
      </section>
    </main>
  );
}

function Generating({ step }: { step: number }) {
  return <main className="generating" id="main-content" aria-live="polite">
    <p className="kicker">Composing your portfolio</p>
    <h1>{activity[Math.min(step, activity.length - 1)]}</h1>
    <ol>{activity.map((label, index) => <li key={label} className={index <= step ? "active" : ""}>{index < step ? "✓" : index === step ? "●" : "○"} <span>{label}</span></li>)}</ol>
  </main>;
}

function Experience({ narrative, evidenceCatalog, context, onContext, onDeepDive, onEvidence, onReset }: {
  narrative: Narrative; evidenceCatalog: PublicEvidence[]; context: VisitorContext; onContext: (value: VisitorContext) => void; onDeepDive: () => void; onEvidence: (refs: string[], contextLabel: string) => void; onReset: () => void;
}) {
  const selectedLabels = context.topics.map((id) => contentPacket.topics.find((topic) => topic.id === id)?.label).filter(Boolean);
  return <main className="experience" id="main-content">
    <header className="experience-header">
      <div><p className="kicker">Ben Shectman · Productively Disruptive</p><p>{selectedLabels.length ? `Framed around ${selectedLabels.join(" · ")}` : "A balanced view across leadership, systems, enterprise experience, and measurement"}</p></div>
      <button className="text-button" onClick={onReset}>Reshape experience</button>
    </header>
    <section className="narrative-intro"><p className="section-number">Your generated experience</p><h1>Design leadership,<br/><em>assembled for you.</em></h1><p>{narrative.grounding === "candidate_validation" ? "Validation mode: framed from unapproved candidate BenFacts so the expanded corpus can be evaluated before approval." : narrative.mode === "ai" ? "AI-framed from a bounded set of approved evidence." : "Assembled deterministically from approved evidence."}</p></section>
    {narrative.grounding === "candidate_validation" && <aside className="validation-notice" role="note"><strong>Temporary validation corpus</strong><span>Claims in this experience are candidates under review and must not be treated as approved portfolio content.</span></aside>}
    <div className="narrative">
      {narrative.sections.map((section, index) => {
        const expanded = context.inlineExpansionsOpened.includes(section.id);
        return <article className={`narrative-block purpose-${section.purpose}`} key={section.id}>
          <div className="block-index">0{index + 1}</div>
          <div className="block-content">
            <p className="purpose">{section.eyebrow}</p><h2>{section.headline}</h2><p className="summary">{section.summary}</p>
            {section.detail && <>
              <button className="disclosure" aria-label={`${expanded ? "Show less" : "Tell me more"} about ${section.headline}`} aria-expanded={expanded} aria-controls={`${section.id}-detail`} onClick={() => onContext({ ...context, inlineExpansionsOpened: expanded ? context.inlineExpansionsOpened.filter((id) => id !== section.id) : [...context.inlineExpansionsOpened, section.id] })}>{expanded ? "Show less" : "Tell me more"} <span aria-hidden="true">{expanded ? "−" : "+"}</span></button>
              {expanded && <div className="inline-detail" id={`${section.id}-detail`}>{section.detail.split(/\n\n+/).map((paragraph, paragraphIndex) => <p key={paragraphIndex}>{paragraph}</p>)}</div>}
            </>}
            {section.disclosure === "deep-dive" && <button className="deep-link" onClick={onDeepDive}>Explore how the XD model evolved <span aria-hidden="true">→</span></button>}
            <EvidenceSignal refs={section.evidenceRefs} contextLabel={section.headline} catalog={evidenceCatalog} onOpen={onEvidence}/>
          </div>
        </article>;
      })}
    </div>
    <footer><p>{narrative.grounding === "candidate_validation" ? "This validation experience uses unapproved candidate facts while preserving personal, leadership, team, shared, and organizational attribution." : "This experience is grounded in approved evidence and preserves the attribution of individual, shared, and organizational work."}</p><button className="text-button" onClick={onReset}>Start again ↑</button></footer>
  </main>;
}

function EvidenceSignal({ refs, contextLabel, catalog = approvedEvidenceCatalog, onOpen }: { refs: string[]; contextLabel: string; catalog?: PublicEvidence[]; onOpen: (refs: string[], contextLabel: string) => void }) {
  const presentation = buildEvidencePresentation(refs, contextLabel, catalog);
  const label = evidencePointsLabel(presentation.items.length, presentation.grounding);
  return <p className="evidence-signal"><strong>Evidence behind this</strong><span aria-hidden="true">·</span><button type="button" onClick={() => onOpen(refs, contextLabel)} aria-label={`${label} behind “${contextLabel}”`}>{label}</button></p>;
}

function EvidenceDialog({ presentation, onClose }: { presentation: EvidencePresentation | null; onClose: () => void }) {
  const count = presentation?.items.length ?? 0;
  return <Dialog className="evidence-dialog" isOpen={Boolean(presentation)} onOpenChange={(open) => { if (!open) onClose(); }} width="min(92vw, 80rem)" maxHeight="88dvh" padding={4} purpose="info">
    {presentation && <>
      <DialogHeader title="Evidence behind this" subtitle={`${evidencePointsLabel(count, presentation.grounding)} supporting “${presentation.contextLabel}”`} onOpenChange={(open) => { if (!open) onClose(); }}/>
      <div className="evidence-dialog-body">
        <p className="evidence-dialog-intro">{presentation.grounding === "candidate_validation" ? "These unapproved candidate facts are being used temporarily to test the adaptive portfolio. They remain subject to Ben’s review." : "These are the approved evidence points used to ground this part of the experience."}</p>
        <Carousel aria-label={`Evidence supporting ${presentation.contextLabel}`} gap={2} hasButtons={count > 1} hasEdgeFade={count > 1} hasSnap>
          {presentation.items.map((item, index) => <Card key={item.id} className="evidence-card" width="var(--evidence-card-width)" minHeight={280} padding={4} variant="default">
            <p className="evidence-card-position">{presentation.grounding === "candidate_validation" ? "Candidate" : "Evidence"} {index + 1} of {count}</p>
            <p className="evidence-card-id">{item.id}</p>
            <p className="evidence-card-claim">{item.claim}</p>
            <p className="evidence-card-attribution">Attribution: {item.attribution.replaceAll("_", " ")}</p>
          </Card>)}
        </Carousel>
      </div>
    </>}
  </Dialog>;
}

function DeepDive({ context, onBack, onEvidence }: { context: VisitorContext; onBack: () => void; onEvidence: (refs: string[], contextLabel: string) => void }) {
  const beats = useMemo(() => buildDeepDiveNarrative(), []);
  return <main className="deep-dive" id="main-content">
    <header><button className="back" onClick={onBack}>← Back to your experience</button><p className="kicker">Focused deep dive · selections preserved</p></header>
    <section className="deep-title"><p className="section-number">From UX service to organizational capability</p><h1>Establish.<br/>Prove. Scale.<br/><em>Institutionalize.</em></h1><p>{contentPacket.stories[0].premise}</p></section>
    <ol className="timeline">
      {beats.map((beat, index) => <li key={beat.id}><div className="year">{beat.period}</div><div><p className="purpose">Stage 0{index + 1}</p><h2>{beat.label}</h2><p className="summary">{beat.summary}</p><EvidenceSignal refs={beat.evidenceRefs} contextLabel={`${beat.label}, ${beat.period}`} onOpen={onEvidence}/></div></li>)}
    </ol>
    <button className="back bottom" onClick={onBack}>← Return to your generated experience</button>
  </main>;
}

export function App() {
  const [view, setView] = useState<"configure" | "generating" | "experience" | "deep-dive">("configure");
  const [step, setStep] = useState(0);
  const [context, setContext] = useState<VisitorContext>({ designSystem: "astryx", theme: "neutral", topics: [], inlineExpansionsOpened: [], deepDivesOpened: [] });
  const [narrative, setNarrative] = useState<Narrative>(() => assembleNarrative([]));
  const [evidenceCatalog, setEvidenceCatalog] = useState<PublicEvidence[]>(approvedEvidenceCatalog);
  const [evidencePresentation, setEvidencePresentation] = useState<EvidencePresentation | null>(null);

  async function generate() {
    const fallback = assembleNarrative(context.topics as TopicId[]);
    setNarrative(fallback); setEvidenceCatalog(approvedEvidenceCatalog); setStep(0); setView("generating");
    const timers = [350, 800, 1300].map((delay, index) => window.setTimeout(() => setStep(index + 1), delay));
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ designSystem: context.designSystem, theme: context.theme, topics: context.topics }) });
      if (response.ok) {
        const generated = GenerateResponseSchema.parse(await response.json());
        setNarrative(generated.narrative);
        setEvidenceCatalog(generated.evidence?.length ? generated.evidence : approvedEvidenceCatalog);
      }
    } catch { setNarrative(fallback); }
    finally { timers.forEach(window.clearTimeout); setView("experience"); window.scrollTo({ top: 0, behavior: "smooth" }); }
  }
  const openDeepDive = () => { setContext((current) => ({ ...current, deepDivesOpened: current.deepDivesOpened.includes("S-001") ? current.deepDivesOpened : [...current.deepDivesOpened, "S-001"] })); setView("deep-dive"); window.scrollTo(0, 0); };
  const openEvidence = (refs: string[], contextLabel: string) => setEvidencePresentation(buildEvidencePresentation(refs, contextLabel, evidenceCatalog));
  const openApprovedEvidence = (refs: string[], contextLabel: string) => setEvidencePresentation(buildEvidencePresentation(refs, contextLabel, approvedEvidenceCatalog));
  return <>
    <a className="skip-link" href="#main-content">Skip to main content</a>
    {view === "configure" && (
      <Configurator context={context} onTopics={(topics) => setContext({ ...context, topics })} onGenerate={generate}/>
    )}
    {view === "generating" && (
      <Generating step={step}/>
    )}
    {view === "experience" && (
      <Experience narrative={narrative} evidenceCatalog={evidenceCatalog} context={context} onContext={setContext} onDeepDive={openDeepDive} onEvidence={openEvidence} onReset={() => setView("configure")}/>
    )}
    {view === "deep-dive" && (
      <DeepDive context={context} onEvidence={openApprovedEvidence} onBack={() => { setView("experience"); window.scrollTo(0, 0); }}/>
    )}
    <EvidenceDialog presentation={evidencePresentation} onClose={() => setEvidencePresentation(null)}/>
  </>;
}

