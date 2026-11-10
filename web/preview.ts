import type { Context, PublicSettings } from '../shared/types.js';
const base = { version: 1, createdAt: '2026-11-10T09:00:00Z', updatedAt: '2026-11-10T09:00:00Z' };
export const previewSettings: PublicSettings = { model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/anthropic', maxTokens: 8192, maxSteps: 30, maxMinutes: 15, searchProvider: 'none', hasKey: false, keySource: 'none', dataHome: '概念设计，不读取私有目录', pythonReady: false, protocol: 'deepseek-messages', dshVersion: '0.2.2-rc.1' };
// Visual reference only. Never loaded by server/runtime or used as real business evidence.
export const previewContext: Context = {
  space: { ...base, id: '00000000-0000-4000-8000-000000000001', name: '示例企业 A', kind: 'company', profile: '概念设计样例，不代表真实企业资料。' },
  matter: { ...base, id: '00000000-0000-4000-8000-000000000002', spaceId: '00000000-0000-4000-8000-000000000001', title: '新市场进入评估（示例）', goal: '', intent: 'general', sessionId: '', runtimeStarted: false },
  messages: [
    { ...base, id: 'preview-user', spaceId: '', caseId: '', role: 'user', content: '比较现有业务与新市场路线，给出下一步。' },
    { ...base, id: 'preview-assistant', spaceId: '', caseId: '', role: 'assistant', content: '**建议：** 先做小范围验证，再决定是否扩大投入。\n\n**依据：** 现有交付可复用；目标市场需求证据待补。\n\n**下一步：** 补充现行报价、客户反馈和当地准入原文。' },
  ], sources: [], materials: [], artifacts: [], actions: [], runs: [], methods: [],
};
