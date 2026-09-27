import assert from 'node:assert/strict';
import test from 'node:test';
import * as transcriptUi from '../web/transcript-inline.js';

const { appendInlineTranscript } = transcriptUi;

function fakeDom() {
  const doc = {
    createTextNode(text) { return { kind: 'text', textContent: text }; },
    createElement(tagName) {
      return { kind: 'element', ownerDocument: doc, tagName: tagName.toUpperCase(), className: '', children: [], append(...children) { this.children.push(...children); } };
    },
  };
  return { ownerDocument: doc, children: [], append(...children) { this.children.push(...children); } };
}

function visibleText(node) {
  return node.textContent ?? (node.children || []).map(visibleText).join('');
}

test('inline rendering puts the struck-through raw token before normal replacement and escapes as text nodes', () => {
  const container = fakeDom();
  appendInlineTranscript(container, {
    rawText: 'The AZERT ID is <ABCD1234>.',
    corrections: [{ original: 'AZERT', replacement: 'Asset', sourceSpan: { start: 4, end: 9 } }],
  });
  assert.equal(visibleText(container), 'The AZERT Asset ID is <ABCD1234>.');
  assert.equal(container.children[1].tagName, 'DEL');
  assert.equal(container.children[1].className, 'transcript-original');
  assert.equal(visibleText(container.children[1]), 'AZERT');
  assert.equal(container.children[2].tagName, 'INS');
  assert.equal(container.children[2].className, 'transcript-replacement');
  assert.equal(visibleText(container.children[2]), ' Asset');
});

test('multiple adjacent corrections remain ordered without duplicate text', () => {
  const container = fakeDom();
  appendInlineTranscript(container, {
    rawText: 'inspextion reslt is various.',
    corrections: [
      { original: 'inspextion', replacement: 'Inspection', sourceSpan: { start: 0, end: 10 } },
      { original: 'reslt', replacement: 'result', sourceSpan: { start: 11, end: 16 } },
    ],
  });
  assert.equal(visibleText(container), 'inspextion Inspection reslt result is various.');
  assert.equal(container.children.filter((node) => node.tagName === 'DEL').length, 2);
});

test('uncorrected statement is unchanged', () => {
  const container = fakeDom();
  appendInlineTranscript(container, { rawText: 'Pressure is 120 PSI.', corrections: [] });
  assert.equal(visibleText(container), 'Pressure is 120 PSI.');
  assert.equal(container.children.length, 1);
});

test('uncorrected compact preview retains its previous whitespace and truncation behavior', () => {
  const container = fakeDom();
  appendInlineTranscript(container, { rawText: '  Pressure   is\n120 PSI.  ', corrections: [], maxLength: 16 });
  assert.equal(visibleText(container), 'Pressure is 120…');
});

test('Latest input uses one inline original-first sentence for an accepted correction', () => {
  assert.equal(typeof transcriptUi.appendLatestStatement, 'function');
  const container = fakeDom();
  transcriptUi.appendLatestStatement(container, {
    status: 'Used', text: 'The AZERT ID is <ABCD1234>.', origin_label: 'Original typed input',
    corrections: [{ original: 'AZERT', replacement: 'Asset', sourceSpan: { start: 4, end: 9 } }],
  });
  const disclosure = container.children[0];
  const evidence = disclosure.children[1];
  assert.equal(disclosure.tagName, 'DETAILS');
  assert.equal(evidence.children.length, 1);
  assert.equal(evidence.children[0].tagName, 'P');
  assert.equal(visibleText(evidence), 'The AZERT Asset ID is <ABCD1234>.');
  assert.equal(evidence.children[0].children[1].tagName, 'DEL');
  assert.equal(evidence.children[0].children[1].className, 'transcript-original');
});

test('Latest input preserves the unchanged statement presentation', () => {
  assert.equal(typeof transcriptUi.appendLatestStatement, 'function');
  const container = fakeDom();
  transcriptUi.appendLatestStatement(container, {
    status: 'Used', text: 'Pressure is 120 PSI.', origin_label: 'Original typed input',
  });
  const evidence = container.children[0].children[1];
  assert.deepEqual(evidence.children.map((child) => child.tagName), ['STRONG', 'P']);
  assert.equal(visibleText(evidence), 'Original typed inputPressure is 120 PSI.');
});
