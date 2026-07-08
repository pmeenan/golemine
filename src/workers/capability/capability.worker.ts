interface CapabilityWorkerResult {
  opfsSyncAccessHandle: boolean;
}

const result: CapabilityWorkerResult = {
  opfsSyncAccessHandle:
    typeof FileSystemFileHandle !== "undefined" &&
    "createSyncAccessHandle" in FileSystemFileHandle.prototype,
};

self.postMessage(result);
