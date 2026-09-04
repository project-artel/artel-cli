import type { ScenarioPayload } from '../../output/contract.js';
import { writeJsonPayload, type OutputSink } from '../../output/envelope.js';
import { printScenario } from '../../output/human.js';

/** `scenario create`·`show`·`update` 가 같은 payload 를 같은 방식으로 낸다. */
export function reportScenario(sink: OutputSink, json: boolean, payload: ScenarioPayload): void {
  if (json) {
    writeJsonPayload(sink, payload);
    return;
  }
  printScenario(sink, payload);
}
