import { useMemo, useState } from "react";
import { contentPacket } from "./content/content";
import { assembleNarrative, buildDeepDiveNarrative } from "./shared/narrative";
import { GenerateResponseSchema, type Narrative, type TopicId, type VisitorContext } from "./shared/contracts";

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
        <p className="grounding-note">Built only from approved evidence. AI shapes the framing, never the facts.</p>
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

function Experience({ narrative, context, onContext, onDeepDive, onReset }: {
  narrative: Narrative; context: VisitorContext; onContext: (value: VisitorContext) => void; onDeepDive: () => void; onReset: () => void;
}) {
  const selectedLabels = context.topics.map((id) => contentPacket.topics.find((topic) => topic.id === id)?.label).filter(Boolean);
  return <main className="experience" id="main-content">
    <header className="experience-header">
      <div><p className="kicker">Ben Shectman · Productively Disruptive</p><p>{selectedLabels.length ? `Framed around ${selectedLabels.join(" · ")}` : "A balanced view across leadership, systems, enterprise experience, and measurement"}</p></div>
      <button className="text-button" onClick={onReset}>Reshape experience</button>
    </header>
    <section className="narrative-intro"><p className="section-number">Your generated experience</p><h1>Design leadership,<br/><em>assembled for you.</em></h1><p>{narrative.mode === "ai" ? "AI-framed from a bounded set of approved evidence." : "Assembled deterministically from approved evidence."}</p></section>
    <div className="narrative">
      {narrative.sections.map((section, index) => {
        const expanded = context.inlineExpansionsOpened.includes(section.id);
        return <article className={`narrative-block purpose-${section.purpose}`} key={section.id}>
          <div className="block-index">0{index + 1}</div>
          <div className="block-content">
            <p className="purpose">{section.purpose}</p><h2>{section.headline}</h2><p className="summary">{section.summary}</p>
            {section.disclosure === "inline" && <>
              <button className="disclosure" aria-expanded={expanded} aria-controls={`${section.id}-detail`} onClick={() => onContext({ ...context, inlineExpansionsOpened: expanded ? context.inlineExpansionsOpened.filter((id) => id !== section.id) : [...context.inlineExpansionsOpened, section.id] })}>{expanded ? "Show less" : "Tell me more"} <span aria-hidden="true">{expanded ? "−" : "+"}</span></button>
              {expanded && <div className="inline-detail" id={`${section.id}-detail`}><p>{section.detail}</p><EvidenceRefs refs={section.evidenceRefs}/></div>}
            </>}
            {section.disclosure === "deep-dive" && <button className="deep-link" onClick={onDeepDive}>Explore how the XD model evolved <span aria-hidden="true">→</span></button>}
            {section.disclosure === "none" && (
              <EvidenceRefs refs={section.evidenceRefs}/>
            )}
          </div>
        </article>;
      })}
    </div>
    <footer><p>This experience is grounded in approved evidence and preserves the attribution of individual, shared, and organizational work.</p><button className="text-button" onClick={onReset}>Start again ↑</button></footer>
  </main>;
}

function EvidenceRefs({ refs }: { refs: string[] }) {
  return <p className="evidence-refs" aria-label={`Supporting evidence: ${refs.join(", ")}`}>Grounded in {refs.join(" · ")}</p>;
}

function DeepDive({ context, onBack }: { context: VisitorContext; onBack: () => void }) {
  const beats = useMemo(() => buildDeepDiveNarrative(), []);
  return <main className="deep-dive" id="main-content">
    <header><button className="back" onClick={onBack}>← Back to your experience</button><p className="kicker">Focused deep dive · selections preserved</p></header>
    <section className="deep-title"><p className="section-number">From UX service to organizational capability</p><h1>Establish.<br/>Prove. Scale.<br/><em>Institutionalize.</em></h1><p>{contentPacket.stories[0].premise}</p></section>
    <ol className="timeline">
      {beats.map((beat, index) => <li key={beat.id}><div className="year">{beat.period}</div><div><p className="purpose">Stage 0{index + 1}</p><h2>{beat.label}</h2><p className="summary">{beat.summary}</p><details><summary>View approved evidence</summary><ul>{beat.evidence.map((item) => <li key={item.id}><strong>{item.id}</strong> {item.claim}<span>Attribution: {item.attribution.replace("_", " ")}</span></li>)}</ul></details></div></li>)}
    </ol>
    <button className="back bottom" onClick={onBack}>← Return to your generated experience</button>
  </main>;
}

export function App() {
  const [view, setView] = useState<"configure" | "generating" | "experience" | "deep-dive">("configure");
  const [step, setStep] = useState(0);
  const [context, setContext] = useState<VisitorContext>({ designSystem: "astryx", theme: "neutral", topics: [], inlineExpansionsOpened: [], deepDivesOpened: [] });
  const [narrative, setNarrative] = useState<Narrative>(() => assembleNarrative([]));

  async function generate() {
    const fallback = assembleNarrative(context.topics as TopicId[]);
    setNarrative(fallback); setStep(0); setView("generating");
    const timers = [350, 800, 1300].map((delay, index) => window.setTimeout(() => setStep(index + 1), delay));
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ designSystem: context.designSystem, theme: context.theme, topics: context.topics }) });
      if (response.ok) setNarrative(GenerateResponseSchema.parse(await response.json()).narrative);
    } catch { setNarrative(fallback); }
    finally { timers.forEach(window.clearTimeout); setView("experience"); window.scrollTo({ top: 0, behavior: "smooth" }); }
  }
  const openDeepDive = () => { setContext((current) => ({ ...current, deepDivesOpened: current.deepDivesOpened.includes("S-001") ? current.deepDivesOpened : [...current.deepDivesOpened, "S-001"] })); setView("deep-dive"); window.scrollTo(0, 0); };
  return <>
    <a className="skip-link" href="#main-content">Skip to main content</a>
    {view === "configure" && (
      <Configurator context={context} onTopics={(topics) => setContext({ ...context, topics })} onGenerate={generate}/>
    )}
    {view === "generating" && (
      <Generating step={step}/>
    )}
    {view === "experience" && (
      <Experience narrative={narrative} context={context} onContext={setContext} onDeepDive={openDeepDive} onReset={() => setView("configure")}/>
    )}
    {view === "deep-dive" && (
      <DeepDive context={context} onBack={() => { setView("experience"); window.scrollTo(0, 0); }}/>
    )}
  </>;
}
