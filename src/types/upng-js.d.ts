declare module 'upng-js' {
  export interface UPNGImage {
    width: number;
    height: number;
    depth: number;
    ctype: number;
    palette: number[][] | null;
    data: Uint8Array;
    tabs: Record<string, unknown>;
  }
  export interface UPNGAPI {
    decode(buffer: ArrayBuffer | Uint8Array): UPNGImage;
    toRGBA8(image: UPNGImage): ArrayBuffer[];
    encode(
      rgba: ArrayLike<Uint8Array | ArrayBuffer>,
      width: number,
      height: number,
      ctype?: number,
      dels?: number[]
    ): ArrayBuffer;
  }
  const api: UPNGAPI;
  export default api;
}
