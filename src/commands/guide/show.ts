import { listGuides, showGuide } from '../../guides/knowledge.js';
import { writeJsonPayload, type OutputSink } from '../../output/envelope.js';

export async function runGuideList(json: boolean, sink: OutputSink): Promise<void> {
  const payload = await listGuides();
  if (json) {
    writeJsonPayload(sink, payload);
    return;
  }
  sink.out(`Source: ${payload.source}\nRevision: ${payload.revision}`);
  for (const topic of payload.topics) sink.out(`${topic.id} — ${topic.title}`);
}

export async function runGuideShow(
  topic: string,
  reference: string | undefined,
  json: boolean,
  sink: OutputSink,
): Promise<void> {
  const payload = await showGuide(topic, reference);
  if (json) {
    writeJsonPayload(sink, payload);
    return;
  }
  sink.out(`Source: ${payload.source}\nRevision: ${payload.revision}\n\n${payload.content}`);
  if (payload.topic.references.length)
    sink.out(`\nReferences (--reference): ${payload.topic.references.join(', ')}`);
}
