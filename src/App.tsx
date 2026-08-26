import { FormEvent, useState } from "react";
import evidence from "./content/evidence.v0.1.json";
import { GenerateResponseSchema } from "./shared/contracts";

const endpoint =
  import.meta.env.VITE_GENERATE_ENDPOINT || "/.netlify/functions/generate";

export function App() {
  const [prompt, setPrompt] = useState("");
  const [answer, setAnswer] = useState("");
  const [status, setStatus] = useState<"idle" | "working" | "error">("idle");

  async function generate(event: FormEvent) {
    event.preventDefault();
    const message = prompt.trim();
    if (!message || status === "working") return;

    setStatus("working");
    setAnswer("");

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message })
      });
      const payload = GenerateResponseSchema.parse(await response.json());
      if (!response.ok || payload.error) throw new Error(payload.error || "Generation failed");
      setAnswer(payload.answer || "");
      setStatus("idle");
    } catch (error) {
      setAnswer(error instanceof Error ? error.message : "Generation failed");
      setStatus("error");
    }
  }

  return (
    <main className="shell">
      <header className="hero">
        <p className="eyebrow">Productively Disruptive · MTI-1</p>
        <h1>Design leadership that turns disruption into durable capability.</h1>
        <p className="lede">
          An evidence-grounded portfolio organized as Establish → Prove → Scale → Institutionalize.
        </p>
      </header>

      <section aria-labelledby="story-title">
        <h2 id="story-title">The transformation story</h2>
        <ol className="stages">
          {evidence.stages.map((stage) => (
            <li key={stage.id}>
              <span>{stage.label}</span>
              <p>{stage.description}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="generator" aria-labelledby="generator-title">
        <p className="eyebrow">Bounded generation</p>
        <h2 id="generator-title">Explore the evidence</h2>
        <form onSubmit={generate}>
          <label htmlFor="prompt">What would you like to understand?</label>
          <textarea
            id="prompt"
            value={prompt}
            maxLength={2000}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="How did the practice move from establishment to scale?"
          />
          <button type="submit" disabled={status === "working"}>
            {status === "working" ? "Generating…" : "Generate"}
          </button>
        </form>
        {answer && <div className="answer" role={status === "error" ? "alert" : "status"}>{answer}</div>}
      </section>
    </main>
  );
}
