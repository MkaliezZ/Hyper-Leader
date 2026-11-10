import { test, expect } from '@playwright/test';
import path from 'node:path';

test('matches the supplied design without treating sample data as real', async ({ page }) => {
  await page.goto('/design-preview');
  await expect(page.getByRole('heading', { name: '今天，先把哪个问题看清楚？' })).toBeVisible();
  await expect(page.getByText('概念设计 · 示例数据')).toBeVisible();
  await expect(page.getByRole('dialog', { name: '添加信息来源' })).toBeVisible();
  await expect(page.getByRole('button', { name: '保存并检查', exact: true })).toBeVisible();
  await expect(page.getByText('尚未检查', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/ui-reference-desktop.png', fullPage: true });
  await page.getByRole('button', { name: '关闭来源抽屉' }).click();
  await expect(page.getByRole('dialog', { name: '添加信息来源' })).not.toBeVisible();
});

test('creates real scoped data, checks a source, runs DSH and preserves a human-confirmed revision', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByText('概念设计 · 示例数据')).toHaveCount(0);
  await page.getByRole('button', { name: '创建工作空间', exact: true }).click();
  const spaceDialog = page.getByRole('dialog', { name: '创建工作空间' });
  await spaceDialog.getByLabel('名称', { exact: true }).fill('浏览器技术验收主体（合成）');
  await spaceDialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(spaceDialog).not.toBeVisible();
  await page.getByRole('button', { name: '新建事项', exact: true }).first().click();
  const matterDialog = page.getByRole('dialog', { name: '新建事项' });
  await matterDialog.getByLabel('事项名称').fill('浏览器流程技术检查（合成）');
  await matterDialog.getByRole('button', { name: '创建事项', exact: true }).click();
  await expect(matterDialog).not.toBeVisible();
  await expect(page.getByLabel('当前事项')).toContainText('浏览器流程技术检查');
  await page.getByRole('button', { name: '添加来源', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '添加信息来源' });
  await drawer.getByLabel('来源名称').fill('浏览器合成来源');
  await drawer.getByLabel('网址', { exact: true }).fill('https://public.test/policy');
  await drawer.getByRole('button', { name: '保存并检查', exact: true }).click();
  await expect(drawer).not.toBeVisible();
  await page.getByRole('button', { name: '信息来源', exact: true }).click();
  await expect(page.getByText('浏览器合成来源', { exact: true })).toBeVisible();
  await expect(page.getByText('可读取', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '正文', exact: true }).click();
  const preview = page.getByRole('dialog', { name: '浏览器合成来源' });
  await expect(preview.getByText('部分或线索，不是完整核验')).toBeVisible();
  await expect(preview.locator('pre')).toContainText('仅用于技术验收');
  await preview.getByRole('button', { name: '关闭对话框' }).click();
  await page.getByRole('button', { name: '工作台', exact: true }).click();
  await page.getByLabel('你的问题').fill('只执行技术验收并保存报告，不作真实经营判断。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('已实际保存浏览器验收合成稿；不是真实模型商业判断。')).toBeVisible({ timeout: 60000 });
  await page.getByRole('button', { name: '报告与版本', exact: true }).click();
  await page.getByRole('button', { name: /浏览器验收报告（合成）/ }).click();
  await expect(page.getByRole('heading', { name: '浏览器验收报告（合成）', exact: true })).toBeVisible();
  const downloadPromise = page.waitForEvent('download'); await page.getByRole('link', { name: 'Markdown', exact: true }).click();
  const download = await downloadPromise; expect(download.suggestedFilename()).toContain('.md'); await download.saveAs(path.join('test-results', 'actual-browser-report.md'));
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '确认此版本', exact: true }).click();
  await expect(page.getByText('人工：用户已确认此版本')).toBeVisible();
  await page.screenshot({ path: 'test-results/actual-report-workspace.png', fullPage: true });
  await page.reload(); await expect(page.getByLabel('当前事项')).toContainText('浏览器流程技术检查');
  expect(errors).toEqual([]);
});

test('source drawer fits a narrow screen and file mode does not require a URL', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/design-preview');
  const drawer = page.getByRole('dialog', { name: '添加信息来源' });
  await drawer.getByRole('button', { name: '文件资料', exact: true }).click();
  await expect(drawer.getByLabel('网址', { exact: true })).toHaveCount(0);
  await expect(drawer.getByRole('button', { name: '保存并检查' })).toBeInViewport();
  await page.screenshot({ path: 'test-results/source-drawer-mobile.png', fullPage: true });
});
