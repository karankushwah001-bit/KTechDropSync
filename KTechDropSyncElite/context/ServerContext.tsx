import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import * as FileSystem from 'expo-file-system/legacy';
import {
  ActivityItem, TextEntry,
  SHARED_DIR, UPLOADS_DIR, SERVER_PORT,
  startServer, stopServer,
  getTexts, getActivities, addPhoneText, removeText as serverRemoveText,
  isTcpAvailable, resolveLocalIp, initDirs
} from '@/server';
import { listFiles, initStorageDirs, FileInfo } from '@/server/storage';

export interface ServerState {
  isRunning: boolean;
  ip: string | null;
  port: number;
  sharedFiles: FileInfo[];
  uploadedFiles: FileInfo[];
  texts: TextEntry[];
  activities: ActivityItem[];
  isStarting: boolean;
  error: string | null;
  tcpAvailable: boolean;
}

interface ServerContextType extends ServerState {
  startServerAction: () => Promise<void>;
  stopServerAction: () => void;
  refreshFiles: () => Promise<void>;
  addFileToShare: (uri: string, name: string) => Promise<void>;
  removeSharedFile: (name: string) => Promise<void>;
  removeUploadedFile: (name: string) => Promise<void>;
  sendText: (text: string) => void;
  deleteText: (id: string) => void;
  refreshTextsAndActivities: () => void;
}

const ServerContext = createContext<ServerContextType | null>(null);

export function ServerProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<ServerState>({
    isRunning: false,
    ip: null,
    port: SERVER_PORT,
    sharedFiles: [],
    uploadedFiles: [],
    texts: [],
    activities: [],
    isStarting: false,
    error: null,
    tcpAvailable: isTcpAvailable(),
  });

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshFiles = useCallback(async () => {
    await initStorageDirs();
    const [shared, uploaded] = await Promise.all([
      listFiles(SHARED_DIR),
      listFiles(UPLOADS_DIR)
    ]);
    setState(prev => ({ ...prev, sharedFiles: shared, uploadedFiles: uploaded }));
  }, []);

  const refreshAll = useCallback(async () => {
    await initStorageDirs();
    const [shared, uploaded] = await Promise.all([
      listFiles(SHARED_DIR),
      listFiles(UPLOADS_DIR)
    ]);
    const currentIp = await resolveLocalIp();
    setState(prev => ({
      ...prev,
      ip: currentIp,
      sharedFiles: shared,
      uploadedFiles: uploaded,
      texts: getTexts(),
      activities: getActivities(),
    }));
  }, []);

  useEffect(() => {
    initStorageDirs().then(() => refreshFiles());
  }, [refreshFiles]);

  useEffect(() => {
    if (state.isRunning) {
      pollRef.current = setInterval(refreshAll, 2000);
    } else {
      if (pollRef.current) clearInterval(pollRef.current);
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [state.isRunning, refreshAll]);

  const startServerAction = useCallback(async () => {
    setState(prev => ({ ...prev, isStarting: true, error: null }));
    try {
      const onUpdate = () => {
        setState(prev => ({ ...prev, texts: getTexts(), activities: getActivities() }));
        refreshFiles();
      };
      
      const resolvedIp = await startServer(SERVER_PORT, onUpdate);
      setState(prev => ({ ...prev, isRunning: true, ip: resolvedIp, isStarting: false, error: null }));
    } catch (err: any) {
      setState(prev => ({ ...prev, isStarting: false, error: err?.message ?? 'Failed to start server' }));
    } finally {
      setState(prev => ({ ...prev, isStarting: false }));
    }
  }, [refreshFiles]);

  const stopServerAction = useCallback(() => {
    stopServer();
    setState(prev => ({ ...prev, isRunning: false, ip: null, error: null }));
  }, []);

  const addFileToShare = useCallback(async (uri: string, name: string) => {
    await initStorageDirs();
    const safeName = name.replace(/[/\\]/g, '_');
    await FileSystem.copyAsync({ from: uri, to: SHARED_DIR + safeName });
    await refreshFiles();
  }, [refreshFiles]);

  const removeSharedFile = useCallback(async (name: string) => {
    await FileSystem.deleteAsync(SHARED_DIR + name, { idempotent: true });
    await refreshFiles();
  }, [refreshFiles]);

  const removeUploadedFile = useCallback(async (name: string) => {
    await FileSystem.deleteAsync(UPLOADS_DIR + name, { idempotent: true });
    await refreshFiles();
  }, [refreshFiles]);

  const sendText = useCallback((text: string) => {
    addPhoneText(text);
    setState(prev => ({ ...prev, texts: getTexts() }));
  }, []);

  const deleteText = useCallback((id: string) => {
    serverRemoveText(id);
    setState(prev => ({ ...prev, texts: getTexts() }));
  }, []);

  const value: ServerContextType = {
    ...state,
    startServerAction,
    stopServerAction,
    refreshFiles,
    addFileToShare,
    removeSharedFile,
    removeUploadedFile,
    sendText,
    deleteText,
    refreshTextsAndActivities: () => setState(prev => ({ ...prev, texts: getTexts(), activities: getActivities() })),
  };

  return <ServerContext.Provider value={value}>{children}</ServerContext.Provider>;
}

export function useServer(): ServerContextType {
  const ctx = useContext(ServerContext);
  if (!ctx) throw new Error('useServer must be used within ServerProvider');
  return ctx;
}
