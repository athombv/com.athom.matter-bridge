import { TestEvidence } from './TestEvidence.mjs';

// Node's custom reporter entry point requires a default export.
export default async function* mutationReporter(events) {
  for await (const event of events) {
    if (event.type === 'test:fail' && !event.data.todo && !event.data.skip) {
      yield JSON.stringify(TestEvidence.failure(event.data)) + '\n';
    }
  }
}
