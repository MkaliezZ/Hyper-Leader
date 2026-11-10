import { expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { testHost, completed } from './helpers.js';

it('parses actual UTF-8/CSV/PDF/DOCX/XLSX files with source locators and no global environment changes', async () => {
  const host = await testHost();
  try {
    const uploaded = await host.leader.upload(host.space.id, host.matter.id, '合成资料.md', Buffer.from('# 合成资料\n本资料只用于技术检查。'), {}); const run = host.leader.checkSource(host.space.id, uploaded.source.id, 1); expect((await completed(host, run.id)).status).toBe('succeeded'); expect(host.leader.sources.preview(host.space.id, uploaded.source.id).text).toContain('合成资料');
    const root = path.join(host.home, 'document-fixtures'); const code = `from pathlib import Path\nfrom docx import Document\nfrom openpyxl import Workbook\nfrom pypdf import PdfWriter\np=Path(${JSON.stringify(root)}); p.mkdir()\nd=Document(); d.add_paragraph('Synthetic DOCX evidence'); d.save(p/'sample.docx')\nw=Workbook(); w.active.append(['item','value']); w.active.append(['synthetic',12]); w.save(p/'sample.xlsx')\nf=PdfWriter(); f.add_blank_page(width=100,height=100); f.write(str(p/'sample.pdf'))\n(p/'sample.csv').write_text('item,value\\nsynthetic,12',encoding='utf8')`;
    await promisify(execFile)(host.config.python(), ['-B', '-X', 'utf8', '-c', code], { encoding: 'utf8' });
    for (const name of ['sample.docx', 'sample.xlsx', 'sample.pdf', 'sample.csv']) { const parsed = await host.leader.workers.parse(path.join(root, name)); if (name.endsWith('.pdf')) { expect(parsed.needs_visual).toBe(true); expect(parsed.metadata.page_count).toBe(1); } else expect(parsed.text).toMatch(/synthetic|Synthetic/); expect(Array.isArray(parsed.sections)).toBe(true); }
    await expect(host.leader.workers.parse(path.join(host.config.root, 'AGENTS.md'))).rejects.toThrow(/越界/);
  } finally { await host.close(); }
});

it('executes the original market, enterprise and international calculation adapters with real output files', async () => {
  const host = await testHost();
  try {
    const market = JSON.parse(await readFile(path.join(host.leader.skills.folder('market'), 'assets/example.json'), 'utf8')); const result = await host.leader.workers.domain(host.space.id, host.matter.id, 'market', 'render', market); expect(result.files.some(file => file.name.endsWith('products.csv'))).toBe(true); expect(result.files.some(file => file.name.endsWith('task-bundle.json'))).toBe(true);
    const match = await host.leader.workers.domain(host.space.id, host.matter.id, 'enterprise', 'match', { profile: { company_name: '合成企业', facts: {} }, policies: [{ id: 'P1', title: '合成政策', url: 'https://example.org/policy', review_state: 'reviewed', policy_validity: 'active', window: { status: 'open', end: '2099-01-01' }, eligibility: { field: 'unknown_fact', op: 'eq', value: true } }] }); expect(match.result.matches[0].action).toBe('VERIFY');
    const evidence = { personal: '仅为合成任务记录', source: 'https://example.org/task', locator: '任务说明', reason: '合成技术评价，不证明真实能力。' }; const assessment = { rubric_version: '2.0', mode: 'opportunity', value: Object.fromEntries(['goal', 'outcome', 'training'].map(key => [key, { ...evidence, score: 4 }])), requirements: [1, 2, 3].map(number => ({ ...evidence, id: String(number), requirement: '任务' + number, kind: 'core_task', weight: 2, status: 'covered' })) };
    const evaluated = await host.leader.workers.domain(host.space.id, host.matter.id, 'international', 'evaluate', assessment); expect(evaluated.result.assessment.value_score).toBe(80); expect(evaluated.result.assessment.readiness_score).toBe(100);
    const international = { name: '合成渲染验收', date: '2026-11-10', skill_version: '0.4.9', ranking_edition: 2027, planning_routes: ['major', 'project', 'branch'].map(id => ({ id, label: id, summary: '合成路线' })), reports: [{ board: 'study', subdir: 'study', title: '合成培养报告', lead: '只验证程序，不代表推荐。', items: [{ id: 'CASE01', title: '合成AI任务', summary: '合成准备路径', choice_class: 'steady', classification_reason: '合成技术校验', classification_boundary: {}, conditions: {}, assessment: { ...assessment, ...evaluated.result.assessment }, source_url: evidence.source, checked_at: '2026-11-10', planning_match: { route: 'major', order: 1, major_basis: '合成课程', experience_basis: '合成项目', rationale: '合成迁移关系', next_output: '拟准备作品', source: evidence.source }, gap_analysis: [{ gap: '合成差距', preparation: '合成准备', completion_standard: '合成成果可核查', support: '合成支持', current_evidence: 'F1兴趣，不是内部ID' }] }] }] };
    const rendered = await host.leader.workers.domain(host.space.id, host.matter.id, 'international', 'render', international); expect(rendered.files.some(file => file.name.endsWith('.html'))).toBe(true); expect(rendered.files.some(file => file.data.toString('utf8').includes('F1兴趣'))).toBe(true);
    const domesticRoot = host.leader.skills.folder('domestic'); const fixtureFile = path.join(host.home, 'domestic-fixture.json');
    const fixtureCode = `import json,runpy\nfrom pathlib import Path\nm=runpy.run_path(${JSON.stringify(path.join(domesticRoot, 'tools/test_job_report.py'))})\ndata={'rubric_version':'3.0','delivery_scope':'calibration','assessment_date':'2026-10-22','report_title':'合成适配器验收','roles':[m['synthetic_role']('001')],'supplemental_roles':[]}\nPath(${JSON.stringify(fixtureFile)}).write_text(json.dumps(data,ensure_ascii=False),encoding='utf8')\n`;
    await promisify(execFile)(host.config.python(), ['-B', '-X', 'utf8', '-c', fixtureCode], { encoding: 'utf8' });
    const domestic = await host.leader.workers.domain(host.space.id, host.matter.id, 'domestic', 'render', JSON.parse(await readFile(fixtureFile, 'utf8'))); expect(domestic.files.some(file => file.name.endsWith('.csv'))).toBe(true); expect(domestic.files.some(file => file.name.endsWith('.html'))).toBe(true);
    await expect(host.leader.workers.domain(host.space.id, host.matter.id, 'enterprise', 'collect', {})).rejects.toThrow(/未开放/);
    await expect(host.leader.workers.domain(host.space.id, host.matter.id, 'market', 'render', { source: 'file:///C:/secret.txt' })).rejects.toThrow(/本机/);
  } finally { await host.close(); }
});

it('binds only an actually read owned source asset and blocks excluded files before domain execution', async () => {
  const host = await testHost();
  try {
    const uploaded = await host.leader.upload(host.space.id, host.matter.id, '合成产品原件.md', Buffer.from('# 合成产品资料\n只用于本机来源绑定检查，不证明产品事实。'), {});
    const run = host.leader.checkSource(host.space.id, uploaded.source.id, 1); await completed(host, run.id);
    const data = JSON.parse(await readFile(path.join(host.leader.skills.folder('market'), 'assets/example.json'), 'utf8'));
    data.sources[0].asset_ref = host.leader.assets.ref(uploaded.asset as any);
    data.sources[0].source_type = 'primary';
    const artifact = await host.leader.evaluate(host.space.id, host.matter.id, 'market', 'render', data, '本地来源绑定技术检查', []);
    expect(artifact.evidenceRefs.some(ref => ref.asset_id === uploaded.asset.id)).toBe(true);
    await host.leader.sources.bind(host.space.id, host.matter.id, []);
    expect((await host.leader.context(host.space.id, host.matter.id, true)).materials).toHaveLength(0);
    await expect(host.leader.evaluate(host.space.id, host.matter.id, 'market', 'render', data, '不应执行', [])).rejects.toThrow(/采用|范围|版本/);
  } finally { await host.close(); }
});
