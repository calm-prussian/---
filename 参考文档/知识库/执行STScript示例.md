function executeSlashCommandsWithOptions(command: string, options?: any): Promise<{
  interrupt: boolean;
  pipe: string;
  isBreak: boolean;
  isAborted: boolean;
  isQuietlyAborted: boolean;
  abortReason: string;
  isError: boolean;
  errorMessage: string;
}>;