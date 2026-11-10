import { Config } from '../server/config.js';
import { Skills } from '../src/function/skills.js';
const config = new Config(process.cwd()); await config.init(); const skills = new Skills(process.cwd(), config.home); await skills.init();
console.log(JSON.stringify({ application: 'Hyper Leader', node: process.version, settings: await config.public(), methods: skills.catalogue().map(({ files, ...method }) => ({ ...method, referenceFiles: files.length })), note: '检测和方法缓存准备，不发送模型请求、不读取其他项目密钥、不证明业务质量。' }, null, 2));
