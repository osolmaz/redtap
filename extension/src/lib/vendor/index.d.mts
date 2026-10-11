// Type surface for the vendored @huggingface/hub bundle (see VENDORED.md).
// The bundle is third-party JavaScript; this shim types the two calls the
// worker uses so the rest of the codebase stays strict.

export type HubBucketRepo = {
  type: 'bucket';
  name: string;
};

export type HubUploadFileParams = {
  repo: HubBucketRepo;
  accessToken: string | undefined;
  file: { path: string; content: Blob };
  commitTitle?: string;
};

export type HubDownloadFileParams = {
  repo: HubBucketRepo;
  accessToken: string | undefined;
  path: string;
  xet?: boolean;
};

export declare function uploadFile(params: HubUploadFileParams): Promise<{ path: string }>;

export declare function downloadFile(params: HubDownloadFileParams): Promise<Blob | null>;
