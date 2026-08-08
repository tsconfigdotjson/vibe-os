// The public face of the sshterm wrapper. Deliberately narrow: everything else
// in this directory is an implementation detail of SshTerminal, and re-exporting
// it invited imports that would have to be kept working.
export { onRuntimeDead } from "./runtime";
export { SshTerminal } from "./SshTerminal";
export type { SshStatus, SshTermConfig } from "./types";
