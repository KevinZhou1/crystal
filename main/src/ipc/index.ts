import { ipcMain } from 'electron';
import type { AppServices } from './types';
import { registerAppHandlers } from './app';
import { registerUpdaterHandlers } from './updater';
import { registerSessionHandlers } from './session';
import { registerProjectHandlers } from './project';
import { registerConfigHandlers } from './config';
import { registerDialogHandlers } from './dialog';
import { registerGitHandlers } from './git';
import { registerScriptHandlers } from './script';
import { registerPromptHandlers } from './prompt';
import { registerStravuHandlers } from './stravu';
import { registerFileHandlers } from './file';


export function registerIpcHandlers(services: AppServices): void {
  registerAppHandlers(ipcMain, services);
  registerUpdaterHandlers(ipcMain, services);
  registerSessionHandlers(ipcMain, services);
  registerProjectHandlers(ipcMain, services);
  registerConfigHandlers(ipcMain, services);
  registerDialogHandlers(ipcMain, services);
  registerGitHandlers(ipcMain, services);
  registerScriptHandlers(ipcMain, services);
  registerPromptHandlers(ipcMain, services);
  registerStravuHandlers(ipcMain, services);
  registerFileHandlers(ipcMain, services);
} 