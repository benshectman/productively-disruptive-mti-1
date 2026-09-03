import type { BenFactReview } from "./benfacts-review";

function words(value: string) {
  return new Set(value.toLowerCase().match(/[a-z0-9]+/g)?.filter((word) => word.length > 3) ?? []);
}

export function similarityScore(current: BenFactReview, candidate: BenFactReview) {
  let score = 0;
  if (current.project_id && current.project_id === candidate.project_id) score += 12;
  const currentSources = new Set(current.source_refs.map((source) => source.source_id));
  score += candidate.source_refs.filter((source) => currentSources.has(source.source_id)).length * 7;
  const currentTopics = new Set(current.topics);
  score += candidate.topics.filter((topic) => currentTopics.has(topic)).length * 3;
  const currentWords = words(current.reviewed_text);
  const candidateWords = words(candidate.reviewed_text);
  const overlap = [...currentWords].filter((word) => candidateWords.has(word)).length;
  const union = new Set([...currentWords, ...candidateWords]).size;
  score += union ? (overlap / union) * 5 : 0;
  return score;
}

export function similarFacts(current: BenFactReview, corpus: BenFactReview[], limit = 5) {
  return corpus
    .filter((candidate) => candidate.candidate_id !== current.candidate_id)
    .map((candidate) => ({ candidate, score: similarityScore(current, candidate) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.candidate.candidate_id.localeCompare(b.candidate.candidate_id))
    .slice(0, limit)
    .map(({ candidate }) => candidate);
}

