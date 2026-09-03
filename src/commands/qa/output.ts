import type { QaRunPayload } from '../../output/contract.js';
import { writeJsonPayload, type OutputSink } from '../../output/envelope.js';
import { printQaRun } from '../../output/human.js';

/** `qa run`·`qa watch`·`qa show` 가 같은 payload 를 같은 방식으로 낸다. */
export function reportQaRun(sink: OutputSink, json: boolean, payload: QaRunPayload): void {
  if (json) {
    writeJsonPayload(sink, payload);
    return;
  }
  printQaRun(sink, payload);
}
