import { describe, expect, it } from 'vitest';

import { parseExpectedLabelEntries, parseScenarioSteps } from '../src/scenario/validate.js';

describe('parseScenarioSteps', () => {
  it('accepts the four fields the QA agent reads, and defaults the optional ones to null', () => {
    const steps = parseScenarioSteps(
      JSON.stringify([
        { action: 'open the game', case_id: 3, hint: 'title screen', input: 'click' },
      ]),
    );
    expect(steps).toEqual([
      { action: 'open the game', case_id: 3, hint: 'title screen', input: 'click' },
    ]);
  });

  it('defaults hint/input/case_id to null when absent', () => {
    const steps = parseScenarioSteps(JSON.stringify([{ action: 'wait' }]));
    expect(steps).toEqual([{ action: 'wait', case_id: null, hint: null, input: null }]);
  });

  it('rejects a field the QA agent does not read, naming it and its position', () => {
    expect(() =>
      parseScenarioSteps(JSON.stringify([{ action: 'ok' }, { action: 'x', caseId: 1 }])),
    ).toThrowError(/steps\[1\] has an unknown field "caseId"/);
  });

  it('rejects a missing or empty action', () => {
    expect(() => parseScenarioSteps(JSON.stringify([{}]))).toThrowError(
      /steps\[0\]\.action must be a non-empty string/,
    );
    expect(() => parseScenarioSteps(JSON.stringify([{ action: '' }]))).toThrowError(
      /steps\[0\]\.action must be a non-empty string/,
    );
  });

  it('rejects a non-array top level, naming the actual type', () => {
    expect(() => parseScenarioSteps(JSON.stringify({ action: 'not an array' }))).toThrowError(
      /steps must be a JSON array, not object/,
    );
    expect(() => parseScenarioSteps(JSON.stringify('just text'))).toThrowError(
      /steps must be a JSON array, not string/,
    );
  });

  it('rejects an element that is not a JSON object', () => {
    expect(() => parseScenarioSteps(JSON.stringify([42]))).toThrowError(
      /steps\[0\] must be a JSON object, not number/,
    );
    expect(() => parseScenarioSteps(JSON.stringify([['nested', 'array']]))).toThrowError(
      /steps\[0\] must be a JSON object, not an array/,
    );
  });

  it('rejects a non-positive or non-integer case_id', () => {
    expect(() => parseScenarioSteps(JSON.stringify([{ action: 'ok', case_id: 0 }]))).toThrowError(
      /steps\[0\]\.case_id must be a positive whole number or null/,
    );
    expect(() => parseScenarioSteps(JSON.stringify([{ action: 'ok', case_id: 1.5 }]))).toThrowError(
      /steps\[0\]\.case_id must be a positive whole number or null/,
    );
    expect(() => parseScenarioSteps(JSON.stringify([{ action: 'ok', case_id: '3' }]))).toThrowError(
      /steps\[0\]\.case_id must be a positive whole number or null/,
    );
  });

  it('rejects a non-string hint or input', () => {
    expect(() => parseScenarioSteps(JSON.stringify([{ action: 'ok', hint: 5 }]))).toThrowError(
      /steps\[0\]\.hint must be a string or null/,
    );
    expect(() => parseScenarioSteps(JSON.stringify([{ action: 'ok', input: false }]))).toThrowError(
      /steps\[0\]\.input must be a string or null/,
    );
  });

  it('reports malformed JSON with the native parser message and no other noise', () => {
    expect(() => parseScenarioSteps('{not json')).toThrowError(/steps must be valid JSON/);
  });

  it('accepts an empty array', () => {
    expect(parseScenarioSteps('[]')).toEqual([]);
  });
});

describe('parseExpectedLabelEntries', () => {
  it('accepts step + expected_passed, including an explicit null (clears the label)', () => {
    const labels = parseExpectedLabelEntries(
      JSON.stringify([
        { step: 1, expected_passed: true },
        { step: 2, expected_passed: false },
        { step: 3, expected_passed: null },
      ]),
    );
    expect(labels).toEqual([
      { step: 1, expected_passed: true },
      { step: 2, expected_passed: false },
      { step: 3, expected_passed: null },
    ]);
  });

  it('rejects an entry missing "step" or "expected_passed", naming the position', () => {
    expect(() =>
      parseExpectedLabelEntries(JSON.stringify([{ expected_passed: true }])),
    ).toThrowError(/\[0\] is missing "step"/);
    expect(() => parseExpectedLabelEntries(JSON.stringify([{ step: 1 }]))).toThrowError(
      /\[0\] is missing "expected_passed"/,
    );
  });

  it('rejects a step number that is not a positive integer', () => {
    expect(() =>
      parseExpectedLabelEntries(JSON.stringify([{ step: 0, expected_passed: true }])),
    ).toThrowError(/\[0\]\.step must be a positive whole number/);
    expect(() =>
      parseExpectedLabelEntries(JSON.stringify([{ step: 1.5, expected_passed: true }])),
    ).toThrowError(/\[0\]\.step must be a positive whole number/);
  });

  it('rejects an expected_passed that is not true, false, or null', () => {
    expect(() =>
      parseExpectedLabelEntries(JSON.stringify([{ step: 1, expected_passed: 'yes' }])),
    ).toThrowError(/\[0\]\.expected_passed must be true, false, or null/);
  });

  it('rejects an unknown field', () => {
    expect(() =>
      parseExpectedLabelEntries(JSON.stringify([{ step: 1, expected_passed: true, note: 'x' }])),
    ).toThrowError(/\[0\] has an unknown field "note"/);
  });
});
