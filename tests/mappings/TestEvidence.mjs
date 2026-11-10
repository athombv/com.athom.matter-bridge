// Acceptance requires executed assertions. A test title or a skipped result is not evidence.
export class TestEvidence {
  results = new Map();
  failed = false;

  record(type, result) {
    let status = 'PASS';
    if (type === 'test:fail') {
      status = 'FAIL';
    } else if (result.skip) {
      status = 'SKIP';
    } else if (result.todo) {
      status = 'TODO';
    }

    if (status !== 'PASS') {
      this.failed = true;
    }
    const previous = this.results.get(result.name);
    if (previous === undefined || previous === 'PASS' || status === 'FAIL') {
      this.results.set(result.name, status);
    }
  }

  require(name) {
    const status = this.results.get(name) ?? 'NOT RUN';
    if (status !== 'PASS') {
      this.failed = true;
    }
    return status;
  }

  static failure(result) {
    const messages = [];
    for (let error = result.details?.error; error; error = error.cause) {
      if (error.message) {
        messages.push(error.message);
      }
    }
    return { name: result.name, failureType: result.details?.error?.failureType, messages };
  }

  static detectsMutation(result, mutation, failures) {
    if (result.code !== 1 || result.signal !== null) {
      return false;
    }
    return failures.some((failure) => {
      if (failure.failureType !== 'testCodeFailure') {
        return false;
      }
      if (mutation.testName) {
        return failure.name === mutation.testName;
      }
      return failure.messages.some((message) => {
        return message.includes(mutation.evidence);
      });
    });
  }
}
