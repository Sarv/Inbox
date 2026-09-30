// libqp ships no type declarations; this covers the one function we call.
declare module 'libqp' {
  export function decode(input: string | Buffer): Buffer;
}
