declare module "m3u8-parser" {
  export class Parser {
    manifest: {
      playlists?: ReadonlyArray<{
        uri: string;
        attributes?: {
          BANDWIDTH?: number;
          "FRAME-RATE"?: number;
          RESOLUTION?: { width: number; height: number };
          CODECS?: string;
        };
      }>;
      mediaSequence?: number;
      targetDuration?: number;
      segments?: ReadonlyArray<{
        uri: string;
        duration: number;
        key?: { method: string; uri: string; iv?: Uint8Array };
        map?: { uri: string; byterange?: { length: number; offset: number } };
        byterange?: { length: number; offset: number };
      }>;
      endList?: boolean;
      contentProtection?: Record<
        string,
        {
          attributes: {
            METHOD: string;
            URI: string;
            KEYFORMAT?: string;
            [key: string]: string | undefined;
          };
        }
      >;
    };
    push(chunk: string): void;
    end(): void;
  }
}
