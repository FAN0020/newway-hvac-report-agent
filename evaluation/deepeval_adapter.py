"""Convert independent component results to DeepEval cases; local Ollama judge only."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT = ROOT / '.tmp' / 'evaluation-runs'
MODEL = 'qwen3.5:9b'


def correction_case(case, prediction):
    from deepeval.test_case import LLMTestCase
    return LLMTestCase(input=prediction['input']['raw_text'], actual_output=prediction['prediction']['text'], expected_output=prediction['expected']['text'])


def rag_case(case, prediction):
    from deepeval.test_case import LLMTestCase
    return LLMTestCase(
        input=prediction['input']['query'],
        actual_output='Retrieved local knowledge records for term normalization; no service action is asserted.',
        expected_output='Relevant technical terms: ' + ', '.join(case['terms']),
        retrieval_context=[hit['text'] for hit in prediction['prediction']['hits']] or ['No knowledge record retrieved.'],
    )


def report_text(prediction):
    draft = prediction['prediction']['draft']
    if 'reportVersion' in draft:
        return '\n'.join(f"{section['title']}: " + ' '.join(section['content']) for section in draft['sections'])
    return '\n'.join(f"{section['title']}: " + ' '.join(item['text'] for item in section['items']) for section in draft['sections'])


def report_case(case, prediction):
    from deepeval.test_case import LLMTestCase
    facts = prediction['input']['facts']
    facts_text = [f"{fact['field']}: {fact['value']} [{fact['fact_id']}]" for fact in facts]
    return LLMTestCase(
        input='Create a ' + case['scope'] + ' service report from only the fixed facts.',
        actual_output=report_text(prediction),
        expected_output='\n'.join(facts_text),
        retrieval_context=facts_text,
        context=[json.dumps(entry['record'], ensure_ascii=False) for entry in prediction['input']['retrieval_context']],
    )


def build_cases(manifest, batch3, batch2=None):
    indexed = {case['case_id']: case for case in manifest['cases']}
    cases = []
    for component in ('rag', 'report'):
        for row in batch3.get('components', {}).get(component, {}).get('results', []):
            if row['status'] == 'RUN':
                cases.append((component, row['case_id'], rag_case(indexed[row['case_id']], row) if component == 'rag' else report_case(indexed[row['case_id']], row)))
    if batch2 and batch2.get('source', {}).get('manifest_sha256') == batch3.get('source', {}).get('manifest_sha256'):
        for row in batch2.get('results', []):
            if row['component'] == 'correction' and row['status'] == 'RUN':
                cases.append(('correction', row['case_id'], correction_case(indexed[row['case_id']], row)))
    return cases


def ollama_ready():
    try:
        with urlopen('http://127.0.0.1:11434/api/tags', timeout=5) as response:
            return any(model['name'] == MODEL for model in json.load(response)['models'])
    except Exception:
        return False


def judge_model():
    from deepeval.models.base_model import DeepEvalBaseLLM
    class LocalOllama(DeepEvalBaseLLM):
        def load_model(self):
            return MODEL
        def get_model_name(self):
            return f'local-ollama/{MODEL}'
        def generate(self, prompt, schema=None):
            payload = {'model': MODEL, 'prompt': prompt, 'stream': False, 'think': False, 'options': {'temperature': 0, 'num_predict': 1024}}
            if schema is not None:
                payload['format'] = schema.model_json_schema()
            request = Request('http://127.0.0.1:11434/api/generate', data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json'})
            with urlopen(request, timeout=180) as response:
                body = json.load(response)
            answer = body.get('response', '')
            return schema.model_validate_json(answer) if schema is not None else answer
        async def a_generate(self, prompt, schema=None):
            return self.generate(prompt, schema)
    return LocalOllama()


def metrics_for(component, model):
    from deepeval.metrics import GEval, ContextualRelevancyMetric, ContextualPrecisionMetric, ContextualRecallMetric, FaithfulnessMetric
    from deepeval.test_case import SingleTurnParams
    if component == 'correction':
        return [('correction_semantic_preservation', GEval(name='Correction semantic preservation', criteria='Preserve the meaning, negation, asset identity, values, units, and completed versus planned actions of the expected correction. Score semantic preservation only; exact strings and critical fields are checked separately.', evaluation_params=[SingleTurnParams.ACTUAL_OUTPUT, SingleTurnParams.EXPECTED_OUTPUT], model=model, async_mode=False))]
    if component == 'rag':
        return [('contextual_relevancy', ContextualRelevancyMetric(model=model, async_mode=False)), ('contextual_precision', ContextualPrecisionMetric(model=model, async_mode=False)), ('contextual_recall', ContextualRecallMetric(model=model, async_mode=False))]
    return [('report_faithfulness_to_seed_facts', FaithfulnessMetric(model=model, async_mode=False)), ('report_semantic_rubric', GEval(name='Report semantic fidelity', criteria='Assess whether the report preserves the supplied facts, negation, units, test results and completion state. Do not reward unsupported service actions or inferred approvals. Ignore missing fields already marked pending.', evaluation_params=[SingleTurnParams.ACTUAL_OUTPUT, SingleTurnParams.EXPECTED_OUTPUT], model=model, async_mode=False))]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument('--smoke', action='store_true', help='Run one report faithfulness judgement only')
    parser.add_argument('--adapter-only', action='store_true', help='Validate conversion without judging')
    args = parser.parse_args()
    os.environ['DEEPEVAL_TELEMETRY_OPT_OUT'] = '1'
    import deepeval
    manifest_bytes = (ROOT / 'evaluation/synthetic-cases.v1.json').read_bytes()
    manifest = json.loads(manifest_bytes)
    batch3 = json.loads((args.output / 'batch3-results.json').read_text())
    manifest_hash = hashlib.sha256(manifest_bytes).hexdigest()
    if manifest_hash != batch3.get('source', {}).get('manifest_sha256'):
        raise ValueError('Batch 3 results use a different case manifest')
    batch2_path = args.output / 'component-results.json'
    batch2 = json.loads(batch2_path.read_text()) if batch2_path.exists() else None
    if batch2 and batch2.get('source', {}).get('manifest_sha256') != manifest_hash:
        raise ValueError('Batch 2 results use a different case manifest')
    cases = build_cases(manifest, batch3, batch2)
    ready = ollama_ready()
    model = judge_model() if ready and not args.adapter_only else None
    results = []
    selected = next(((kind, id_, case) for kind, id_, case in cases if kind == 'report'), None) if args.smoke else None
    for kind, case_id, test_case in cases:
        for metric_name in [name for name, _ in metrics_for(kind, model)] if model else {'correction':['correction_semantic_preservation'], 'rag':['contextual_relevancy','contextual_precision','contextual_recall'], 'report':['report_faithfulness_to_seed_facts','report_semantic_rubric']}[kind]:
            if args.smoke and (selected is None or (kind, case_id) != selected[:2] or metric_name != 'report_faithfulness_to_seed_facts'):
                results.append({'component':kind,'case_id':case_id,'metric':metric_name,'status':'NOT_RUN','reason':'SMOKE_SELECTION'})
                continue
            if args.adapter_only or not ready:
                results.append({'component':kind,'case_id':case_id,'metric':metric_name,'status':'NOT_RUN','reason':'ADAPTER_ONLY' if args.adapter_only else 'LOCAL_OLLAMA_MODEL_UNAVAILABLE'})
                continue
            try:
                metric = dict(metrics_for(kind, model))[metric_name]
                metric.measure(test_case)
                results.append({'component':kind,'case_id':case_id,'metric':metric_name,'status':'RUN','score':metric.score,'reason':metric.reason})
            except Exception as error:
                results.append({'component':kind,'case_id':case_id,'metric':metric_name,'status':'NOT_RUN','reason':'JUDGE_ERROR','detail':f'{type(error).__name__}: {error}'})
    output = {'contract_version':'batch3-deepeval.v1','label_status':'PROVISIONAL_SYNTHETIC_SEED','frozen_gold':False,'source':{'manifest_sha256':manifest_hash,'batch3_fixture_sha256':batch3['source']['fixture_sha256'],'batch2_fixture_sha256':batch2['source']['fixture_sha256'] if batch2 else None},'deepeval_version':getattr(deepeval,'__version__','4.2.3'),'judge':f'local-ollama/{MODEL}' if ready else None,'adapter_cases':len(cases),'results':results}
    args.output.mkdir(parents=True,exist_ok=True)
    (args.output / 'deepeval-results.json').write_text(json.dumps(output,indent=2,ensure_ascii=False)+'\n')
    lines = ['# DeepEval semantic evaluation', '', 'Synthetic seed only; local Ollama judge. Semantic scores do not replace deterministic metrics or safety gates.', '', f"Adapter cases: {len(cases)}; judge: {output['judge'] or 'unavailable'}", '']
    for row in results:
        lines.append(f"- {row['component']} {row['case_id']} {row['metric']}: {row['status']}" + (f" score={row['score']:.3f}" if row['status']=='RUN' else f" ({row['reason']})"))
    (args.output / 'deepeval-results.md').write_text('\n'.join(lines)+'\n')
    print(json.dumps({'adapter_cases':len(cases),'run':sum(row['status']=='RUN' for row in results),'not_run':sum(row['status']=='NOT_RUN' for row in results),'judge':output['judge']}))

if __name__ == '__main__':
    main()
