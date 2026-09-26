import assert from 'node:assert/strict';
import test from 'node:test';
import { extractV2Facts, splitSentences } from '../../src/tools/extract-v2-facts.js';
import { isCriticalField } from '../../src/v2/fact-schemas.js';
import { loadScopeRegistry } from '../../src/v2/scope.js';

/** Reads the real V2 scope registry (data/knowledge/v2/scope-registry.v1.json). */
const registry = await loadScopeRegistry();

const hasField = (facts, field) => facts.some((fact) => fact.field === field);
const valueOf = (facts, field) => facts.find((fact) => fact.field === field)?.value;

/* ------------------------------------------------------------------ *
 * splitSentences
 * ------------------------------------------------------------------ */

test('splitSentences splits mixed Chinese/English on terminators', () => {
  assert.deepEqual(splitSentences('Aircon not cooling. 检查发现电容损坏。'), [
    'Aircon not cooling',
    '检查发现电容损坏',
  ]);
  assert.deepEqual(splitSentences('间隙 3 mm。更换电容。'), ['间隙 3 mm', '更换电容']);
  assert.deepEqual(splitSentences('C751A 车组报门控故障。\n测试通过。'), [
    'C751A 车组报门控故障',
    '测试通过',
  ]);
});

test('splitSentences keeps decimal points and untruncated sentences', () => {
  assert.deepEqual(splitSentences('胎纹深度 3.5 mm'), ['胎纹深度 3.5 mm']);
  assert.deepEqual(splitSentences('更换了一个35 µF电容'), ['更换了一个35 µF电容']);
  assert.deepEqual(splitSentences(''), []);
  assert.deepEqual(splitSentences('   '), []);
});

/* ------------------------------------------------------------------ *
 * BUS main text (task scenario)
 * ------------------------------------------------------------------ */

test('BUS text extracts parts/test/completion with correct support & critical', async () => {
  const res = await extractV2Facts({
    contextId: 'SBS/BUS',
    rawText: '客户反映空调不制冷。检查发现运行电容损坏。更换了一个35 µF电容。试机运行正常。问题已解决。',
    registry,
  });
  const { facts } = res;
  assert.ok(Array.isArray(facts));
  assert.ok(Array.isArray(res.warnings));

  // parts
  assert.ok(hasField(facts, 'parts.part_number'), 'parts.part_number missing');
  assert.equal(valueOf(facts, 'parts.part_number'), '运行电容');
  assert.ok(hasField(facts, 'parts.replaced'), 'parts.replaced missing');
  assert.equal(valueOf(facts, 'parts.replaced'), 'true');

  // test + completion
  assert.equal(valueOf(facts, 'test.result'), '试机运行正常');
  assert.equal(valueOf(facts, 'completion.state'), 'completed');

  // root cause + work description (explicit statements)
  assert.equal(valueOf(facts, 'diagnosis.root_cause'), '检查发现运行电容损坏');
  assert.ok(hasField(facts, 'work.description'));

  // every fact carries the V2 contract envelope
  for (const fact of facts) {
    assert.equal(fact.support_status, 'DIRECT_TRANSCRIPT');
    assert.equal(fact.source, 'manual');
    assert.equal(typeof fact.critical, 'boolean');
    assert.equal(fact.critical, isCriticalField({ scopeId: 'SBS_BUS', field: fact.field }));
  }

  // critical flags match the schema catalog
  assert.equal(isCriticalField({ scopeId: 'SBS_BUS', field: 'parts.part_number' }), true);
  assert.equal(valueOf(facts, 'parts.replaced'), 'true');
  assert.equal(
    facts.find((f) => f.field === 'parts.replaced').critical,
    isCriticalField({ scopeId: 'SBS_BUS', field: 'parts.replaced' }),
  );
  assert.equal(facts.find((f) => f.field === 'parts.replaced').critical, true);
  assert.equal(facts.find((f) => f.field === 'test.result').critical, true);
  assert.equal(facts.find((f) => f.field === 'completion.state').critical, true);
  assert.equal(facts.find((f) => f.field === 'work.description').critical, false);
});

test('BUS model MAN A95 maps to asset.bus_model and work.type', async () => {
  const { facts } = await extractV2Facts({
    contextId: 'SBS/BUS',
    rawText: 'MAN A95 巴士预防性保养完成。',
    registry,
  });
  assert.equal(valueOf(facts, 'asset.bus_model'), 'MAN A95');
  assert.equal(valueOf(facts, 'work.type'), 'preventive');
  assert.equal(valueOf(facts, 'completion.state'), 'completed');
  assert.equal(
    facts.find((f) => f.field === 'asset.bus_model').critical,
    isCriticalField({ scopeId: 'SBS_BUS', field: 'asset.bus_model' }),
  );
});

test('BUS dictated registration, return to service, and explicit safety statement are extracted', async () => {
  const { facts } = await extractV2Facts({
    contextId: 'SBS/BUS',
    rawText: 'Registration SBS6025Z. The bus was returned to the service and no additional safety issue was observed.',
    registry,
  });
  assert.equal(valueOf(facts, 'asset.registration_no'), 'SBS6025Z');
  assert.equal(valueOf(facts, 'completion.state'), 'completed');
  assert.equal(valueOf(facts, 'safety.assertion'), 'The bus was returned to the service and no additional safety issue was observed');
  assert.equal(facts.find((fact) => fact.field === 'asset.registration_no').critical, true);
});

test('BUS measurement sentence yields measurement fact with unit', async () => {
  const { facts } = await extractV2Facts({
    contextId: 'SBS/BUS',
    rawText: '检查发现制动片磨损，胎纹深度 3 mm。',
    registry,
  });
  const measurement = facts.find((f) => f.field.startsWith('measurement.'));
  assert.ok(measurement, 'measurement fact missing');
  assert.equal(measurement.value, '3');
  assert.equal(measurement.unit, 'mm');
  assert.equal(measurement.critical, true);
});

/* ------------------------------------------------------------------ *
 * RAIL text (task scenario)
 * ------------------------------------------------------------------ */

test('RAIL text extracts stock_class/parts/test/completion/safety', async () => {
  const res = await extractV2Facts({
    contextId: 'SBS/RAIL',
    rawText: 'C751A 车组报门控故障。检查发现集电靴磨损。更换了集电靴。测试通过。已回役。',
    registry,
  });
  const { facts } = res;
  assert.ok(Array.isArray(facts));
  assert.ok(Array.isArray(res.warnings));

  assert.equal(valueOf(facts, 'asset.stock_class'), 'Alstom Metropolis C751A');
  assert.equal(valueOf(facts, 'parts.part_number'), '集电靴');
  assert.equal(valueOf(facts, 'parts.replaced'), 'true');
  assert.equal(valueOf(facts, 'test.result'), '测试通过');
  assert.equal(valueOf(facts, 'completion.state'), 'completed');

  // 回役 triggers a safety.* assertion
  const safety = facts.find((f) => f.field.startsWith('safety.'));
  assert.ok(safety, 'safety assertion missing (回役 should trigger safety.*)');
  assert.equal(safety.value, '已回役');

  // envelope + critical per schema for every fact
  for (const fact of facts) {
    assert.equal(fact.support_status, 'DIRECT_TRANSCRIPT');
    assert.equal(fact.source, 'manual');
    assert.equal(fact.critical, isCriticalField({ scopeId: 'SBS_RAIL', field: fact.field }));
  }
  assert.equal(facts.find((f) => f.field === 'test.result').critical, true);
  assert.equal(facts.find((f) => f.field === 'completion.state').critical, true);
  assert.equal(safety.critical, true);
});

test('RAIL NEL maps to asset.line', async () => {
  const { facts } = await extractV2Facts({
    contextId: 'SBS/RAIL',
    rawText: 'NEL 线路进行预防性维护。',
    registry,
  });
  assert.equal(valueOf(facts, 'asset.line'), '东北线');
  assert.equal(valueOf(facts, 'work.type'), 'preventive');
});

/* ------------------------------------------------------------------ *
 * Contract §13 discipline — no invented actions
 * ------------------------------------------------------------------ */

test('检查但未更换 → no parts.replaced', async () => {
  const { facts } = await extractV2Facts({
    contextId: 'SBS/BUS',
    rawText: '检查发现电容轻微磨损，未更换。',
    registry,
  });
  assert.ok(!hasField(facts, 'parts.replaced'), 'negated replacement must not yield parts.replaced');
  // the part itself is still explicitly mentioned
  assert.equal(valueOf(facts, 'parts.part_number'), '运行电容');
});

test('手册建议更换 → no parts.replaced (recommendation ≠ occurred action)', async () => {
  const { facts } = await extractV2Facts({
    contextId: 'SBS/BUS',
    rawText: '手册建议更换电容。',
    registry,
  });
  assert.ok(!hasField(facts, 'parts.replaced'), 'recommendation must not yield parts.replaced');
  assert.equal(valueOf(facts, 'parts.part_number'), '运行电容');
});

test('未回役 → out_of_service, not completed', async () => {
  const { facts } = await extractV2Facts({
    contextId: 'SBS/RAIL',
    rawText: 'C751A 检查发现集电靴磨损，未回役。',
    registry,
  });
  assert.equal(valueOf(facts, 'completion.state'), 'out_of_service');
});

/* ------------------------------------------------------------------ *
 * Errors and empty input
 * ------------------------------------------------------------------ */

test('HVAC context throws a clear SBS-only error', async () => {
  await assert.rejects(
    () => extractV2Facts({ contextId: 'HVAC', rawText: '客户反映空调不制冷。', registry }),
    /SBS/u,
  );
});

test('unknown context id throws', async () => {
  await assert.rejects(
    () => extractV2Facts({ contextId: 'NOT/A_CONTEXT', rawText: 'x', registry }),
    /Unknown V2 context/u,
  );
});

test('no matching input → empty facts and unrecognized warning', async () => {
  const { facts, warnings } = await extractV2Facts({
    contextId: 'SBS/BUS',
    rawText: '今天天气不错。',
    registry,
  });
  assert.deepEqual(facts, []);
  assert.ok(warnings.some((warning) => warning.includes('Unrecognized: 今天天气不错')));
});

test('registry may be omitted (loaded internally)', async () => {
  const { facts } = await extractV2Facts({
    contextId: 'SBS/BUS',
    rawText: '更换了轮胎。',
  });
  assert.equal(valueOf(facts, 'parts.part_number'), '轮胎');
  assert.equal(valueOf(facts, 'parts.replaced'), 'true');
});

test('OILFIELD text extracts source-grounded pipeline inspection facts', async () => {
  const { facts } = await extractV2Facts({
    contextId: 'OILFIELD',
    rawText: '对原油输油管道东段开展安全检查。依据 GB50253-2014第4.2.3条，现场测得管顶覆土厚度0.7m，不符合要求，发现覆土不足隐患。已完成整改。复测通过。安全隔离已确认，检查完成。',
    registry,
  });
  assert.equal(valueOf(facts, 'asset.equipment'), '原油输油管道');
  assert.match(valueOf(facts, 'standard.reference'), /GB50253-2014/);
  assert.ok(hasField(facts, 'inspection.item'));
  assert.ok(hasField(facts, 'inspection.result'));
  assert.ok(hasField(facts, 'defect.description'));
  assert.ok(hasField(facts, 'work_performed'));
  assert.ok(hasField(facts, 'test.result'));
  assert.equal(valueOf(facts, 'completion.state'), 'completed');
  assert.ok(hasField(facts, 'safety.assertion'));
});

test('OILFIELD spoken transcript preserves metre values, completed remediation, and corrected standard', async () => {
  const { facts } = await extractV2Facts({
    contextId: 'OILFIELD',
    rawText: '检查依据为GB50235。错了，GB50253-2014第四点二点三条。管顶覆土厚度为0.7米，低于0.8米要求。已完成补土整改。复测覆土厚度为0.85米。',
    registry,
  });
  const standards = facts.filter((fact) => fact.field === 'standard.reference').map((fact) => fact.value);
  assert.deepEqual(standards, ['GB50253-2014']);
  assert.deepEqual(
    facts.filter((fact) => fact.field.startsWith('measurement.')).map((fact) => [fact.value, fact.unit]),
    [['0.7', 'm'], ['0.8', 'm'], ['0.85', 'm']],
  );
  assert.ok(hasField(facts, 'work_performed'));
});

test('POWER_GRID text extracts insulating-oil test identity, values, and safety', async () => {
  const { facts } = await extractV2Facts({
    contextId: 'POWER/GRID',
    rawText: '对2号主变绝缘油进行检测，电压等级220kV。依据 GB 50150-2016。击穿电压平均值62.97kV，测试通过。环境温度21℃，湿度54%。检测完成，安全措施已确认。',
    registry,
  });
  assert.ok(facts.some((fact) => fact.field === 'asset.equipment' && fact.value === '绝缘油'));
  assert.equal(valueOf(facts, 'asset.voltage_level'), '220kV');
  assert.match(valueOf(facts, 'standard.reference'), /GB 50150-2016/);
  assert.ok(facts.some((fact) => fact.field.startsWith('measurement.') && fact.unit.toLowerCase() === 'kv'));
  assert.equal(valueOf(facts, 'measurement.breakdown_voltage'), '62.97');
  assert.equal(valueOf(facts, 'measurement.temperature'), '21');
  assert.equal(valueOf(facts, 'measurement.humidity'), '54');
  assert.equal(facts.filter((fact) => fact.field === 'asset.voltage_level').length, 1);
  assert.ok(hasField(facts, 'test.result'));
  assert.equal(valueOf(facts, 'completion.state'), 'completed');
  assert.ok(hasField(facts, 'safety.assertion'));
});
