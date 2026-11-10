// Uses the public DSH tool-authoring contract. No custom model loop.
import { defineTool } from '@deepseek-ai/dsh-tools';
export const name = 'hyper-leader-only';
export const inject = ['tools'];
const s = (description, required = false) => ({ type: 'string', description, ...(required ? { required: true } : {}) });
const definitions = [
  ['leader_context', '读取当前主体和事项的真实材料、来源版本、报告、任务及方法目录。保存或补充资料后重新读取。', {}],
  ['leader_reference', '读取实际登记的方法文件。domain 为 market/enterprise/domestic/international/protocol；name 如 SKILL.md、references/method.md。', { domain: s('方法领域', true), name: s('登记的方法相对路径', true) }],
  ['leader_schema', '读取专项工具输入约束与可执行领域操作；不是任意文件。', {}],
  ['leader_sources', '读取当前事项允许的来源目录、快照状态、范围和缺项。', {}],
  ['leader_find_sources', '按当前任务发现来源；目录和搜索摘要是线索，不是全文或完整市场。搜索未配置时如实返回缺项。不要发送私人全文或密钥。', { query: s('简短议题、任务或地区关键词', true) }],
  ['leader_read_source', '只读当前允许来源，或在授权研究范围内补读公开网页。本机/内网/凭据链接被拒绝。返回实际正文与引用，不证明业务资格。', { source_id: s('已登记来源ID'), url: s('补充的公开网页URL') }],
  ['leader_register_source', '提出保存来源的请求，由用户明确确认范围后才登记；不自动认证机构、注册账号或开订阅。', { name: s('来源名称', true), url: s('公开网页或栏目URL', true), kind: s('page/website/rss'), scope: s('case/space') }],
  ['leader_read_material', '读取当前事项上传资料的实际解析文本和定位。不能传任意路径。', { asset_id: s('原始上传资产ID', true) }],
  ['leader_evaluate', '调用注册的四包计算、条件预筛、校验或渲染。data_json 按原方法数据契约，不接受任意文件路径/代码。evidence_json 是本轮实际资产引用数组。', { domain: s('market/enterprise/domestic/international', true), operation: s('注册操作', true), data_json: s('严格JSON数据', true), title: s('实际成果标题', true), evidence_json: s('[{"asset_id":"...","version":"1"}]') }],
  ['leader_save_artifact', '实际保存分析/报告/计划为新版本并保留来源。AI输出均是待评议，不自动填人工认可或现实效果。', { title: s('标题', true), content: s('完整Markdown正文', true), summary: s('简明结论'), kind: s('analysis/market_report/opportunity_report/development_plan/action_plan/note'), domain: s('对应领域，可省略'), evidence_json: s('真实资产引用数组'), artifact_id: s('修订已有成果ID'), expected_version: { type: 'integer', description: '修订前读取到的记录版本' } }],
  ['leader_add_action', '在当前事项保存具体行动，不将计划写成已经完成。', { title: s('动作', true), owner: s('负责人或待指定'), due: s('真实日期或留空'), acceptance: s('验收物'), evidence_json: s('实际依据引用数组') }],
  ['leader_ask_user', '只对决定性缺项、选择或授权提问，返回用户的实际回答。沉默、预选和AI自评不算认可。', { question: s('需要用户回答的具体问题', true), options: { type: 'array', items: { type: 'string' } } }],
];
export function apply(ctx) {
  const base = process.env.LEADER_BRIDGE;
  const token = process.env.LEADER_BRIDGE_TOKEN;
  if (!base || !token || !/^http:\/\/127\.0\.0\.1:\d+\/internal\/runtime\/[a-zA-Z0-9_-]+$/.test(base)) throw new Error('Missing scoped Hyper Leader bridge');
  const allowed = new Set(definitions.map(row => row[0]));
  ctx.tools.guard(call => { if (!allowed.has(call.name)) return 'Hyper Leader 只允许当前事项的专项工具；未开放通用终端、文件系统或其他Agent。'; });
  for (const [name, description, parameters] of definitions) ctx.tools.register(defineTool({ name, description, parameters,
    output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
    async execute(args, exec) { const response = await fetch(base, { method: 'POST', redirect: 'error', signal: exec.signal, headers: { 'Content-Type': 'application/json', 'X-Runtime-Token': token }, body: JSON.stringify({ tool: name, args }) }); const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result)); return JSON.stringify(result); }
  }));
}
