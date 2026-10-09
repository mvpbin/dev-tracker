const { app, BrowserWindow, dialog, ipcMain, clipboard } = require('electron');
const path = require('node:path');
const { mkdir, copyFile, readFile, writeFile, stat } = require('node:fs/promises');
const { constants } = require('node:fs');
const { pathToFileURL } = require('node:url');

let server;
let pipeService;
let openWindow;
let diagnostics, diagnosticsFile, recordsBusy = false, quitting = false, pendingQuit = false;
const windows = new Map();
function saveDiagnostics() {
  if (!diagnosticsFile) return;
  try { diagnostics.save(diagnosticsFile); }
  catch (error) { diagnostics.record('error', { stage: 'export', error }); }
}
async function closePipeService() {
  const result = await pipeService?.close();
  pipeService = undefined;
  if (result?.cleanupWarning) {
    const error = new Error('Pipe discovery cleanup failed'); error.code = result.cleanupWarning;
    diagnostics?.record('error', { stage: 'desktop', error });
  }
}
function contextFor(event) {
  const context = windows.get(event.sender.id);
  if (!context) throw new Error('无效窗口');
  return context;
}
if (process.env.DEV_TRACKER_TEST_DATA) app.setPath('userData', process.env.DEV_TRACKER_TEST_DATA);
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    openWindow?.().catch(error => dialog.showErrorBox('新窗口打开失败', error.message));
  });
  app.whenReady().then(async () => {
    const { createDiagnostics } = await import(pathToFileURL(path.join(__dirname, '../diagnostics.js')).href);
    diagnostics = createDiagnostics(); diagnostics.record('startup', { stage: 'desktop' });
    const storage = process.env.DEV_TRACKER_TEST_DATA || app.getPath('userData');
    await mkdir(storage, { recursive: true });
    diagnosticsFile = path.join(storage, 'diagnostics.jsonl'); saveDiagnostics();
    if (!app.isPackaged && !process.env.DEV_TRACKER_TEST_DATA) {
      try {
        await copyFile(path.join(__dirname, '../.data/project.json'), path.join(storage, 'project.json'), constants.COPYFILE_EXCL);
      } catch (error) { if (!['ENOENT', 'EEXIST'].includes(error.code)) throw error; }
    }
    const { startServer } = await import(pathToFileURL(path.join(__dirname, '../server.js')).href);
    server = await startServer({ storage, port: process.env.DEV_TRACKER_TEST_DATA ? 0 : 4318, diagnostics });
    const { startPipeServer } = await import(pathToFileURL(path.join(__dirname, '../pipe-server.js')).href);
    pipeService = await startPipeServer(server, { directory: path.join(storage, 'mcp-connection') });
    saveDiagnostics();
    const url = `http://127.0.0.1:${server.address().port}`;
    openWindow = async descriptor => {
      const context = descriptor || await server.createWindow();
      const window = new BrowserWindow({
        width: 1280, height: 820, minWidth: 720, minHeight: 560,
        title: '开发地图', autoHideMenuBar: true,
        webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true }
      });
      const contentsId = window.webContents.id;
      windows.set(contentsId, { window, id: context.id });
      window.on('closed', () => windows.delete(contentsId));
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', (event, destination) => {
        if (new URL(destination).origin !== url) event.preventDefault();
      });
      await window.loadURL(url + context.path);
    };
    ipcMain.handle('copy-text', async (event, text) => {
      if (!windows.has(event.sender.id) || typeof text !== 'string') throw new Error('无效复制请求');
      await clipboard.writeText(text);
      if (await clipboard.readText() !== text) throw new Error('系统剪贴板未保存内容，请稍后重试或导出交接记录');
    });
    ipcMain.handle('choose-project', async event => {
      const context = windows.get(event.sender.id);
      if (!context) throw new Error('无效窗口');
      const choice = await dialog.showOpenDialog(context.window, { properties: ['openDirectory'] });
      if (!choice.canceled) await server.selectProject(choice.filePaths[0], context.id);
    });
    ipcMain.handle('new-window', async event => {
      if (!windows.has(event.sender.id)) throw new Error('无效窗口');
      await openWindow();
    });
    ipcMain.handle('parallel-window', async event => {
      const context = windows.get(event.sender.id);
      if (!context) throw new Error('无效窗口');
      await openWindow(await server.createParallelWindow(context.id));
    });
    ipcMain.handle('export-diagnostics', async event => {
      const { window } = contextFor(event);
      const choice = await dialog.showSaveDialog(window, { defaultPath: 'dev-tracker-diagnostics.jsonl', filters: [{ name: 'JSON Lines', extensions: ['jsonl'] }] });
      contextFor(event);
      if (choice.canceled) return false;
      saveDiagnostics(); await writeFile(choice.filePath, diagnostics.exportJSONL(), 'utf8');
      return true;
    });
    ipcMain.handle('backup-records', async event => {
      const { window } = contextFor(event);
      if (recordsBusy) throw new Error('正在处理记录备份或恢复');
      recordsBusy = true;
      try {
        const choice = await dialog.showSaveDialog(window, { defaultPath: 'dev-tracker-records.json', filters: [{ name: '记录备份', extensions: ['json'] }] });
        contextFor(event);
        if (choice.canceled) return false;
        await writeFile(choice.filePath, JSON.stringify(await server.backupRecords(), null, 2), 'utf8');
        return true;
      } catch (error) { diagnostics.record('error', { stage: 'backup', error }); saveDiagnostics(); throw error; }
      finally { recordsBusy = false; if (pendingQuit && server) { pendingQuit = false; app.quit(); } }
    });
    ipcMain.handle('restore-records', async event => {
      const { window } = contextFor(event);
      if (recordsBusy) throw new Error('正在处理记录备份或恢复');
      recordsBusy = true;
      try {
        const choice = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: '记录备份', extensions: ['json'] }] });
        contextFor(event);
        if (choice.canceled) return false;
        if ((await stat(choice.filePaths[0])).size > 50 * 1024 * 1024) throw new Error('备份文件超过 50 MB');
        const archive = JSON.parse(await readFile(choice.filePaths[0], 'utf8'));
        const confirmation = await dialog.showMessageBox(window, { type: 'warning', buttons: ['取消', '替换全部记录并重启'], defaultId: 0, cancelId: 0, title: '恢复记录备份', message: '此操作将替换全部本地项目记录。', detail: '备份不包含项目源码。建议先导出现有记录备份。恢复成功后应用将重启。' });
        contextFor(event);
        if (confirmation.response !== 1) return false;
        const result = await server.restoreRecords(archive);
        if (result.cleanupWarning) await dialog.showMessageBox(window, { type: 'warning', buttons: ['重启'], title: '记录已恢复', message: '记录已恢复，但旧记录临时文件未能清理。', detail: result.cleanupWarning });
        await server.shutdown(); await closePipeService(); server = undefined;
        diagnostics.record('close', { stage: 'desktop' }); saveDiagnostics();
        app.relaunch(); app.exit(0);
        return true;
      } catch (error) { diagnostics.record('error', { stage: 'restore', error }); saveDiagnostics(); throw error; }
      finally { recordsBusy = false; if (pendingQuit && server) { pendingQuit = false; app.quit(); } }
    });
    await openWindow();
  }).catch(error => {
    diagnostics?.record('error', { stage: 'desktop', error }); saveDiagnostics();
    dialog.showErrorBox('开发地图启动失败', error.message);
    app.quit();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (!server) return;
    if (recordsBusy) {
      event.preventDefault();
      pendingQuit = true;
      return;
    }
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    server.shutdown().then(async () => {
      await closePipeService();
      server = undefined;
      diagnostics?.record('close', { stage: 'desktop' }); saveDiagnostics();
      app.quit();
    }).catch(error => {
      quitting = false;
      diagnostics?.record('error', { stage: 'desktop', error }); saveDiagnostics();
      dialog.showErrorBox('退出失败，应用仍在运行', error.message);
    });
  });
}
