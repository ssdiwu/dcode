// Pi's getShellEnv() includes the entire Host environment. Agent commands only
// inherit ordinary shell configuration; model credentials stay with the Host.
const AGENT_SHELL_ENV_KEYS=['PATH','HOME','USER','LOGNAME','SHELL','TMPDIR','LANG','LC_ALL','LC_CTYPE','TERM','TZ'] as const;

export function agentShellEnvironment(source:NodeJS.ProcessEnv):NodeJS.ProcessEnv {
  const env:NodeJS.ProcessEnv={};
  for(const key of AGENT_SHELL_ENV_KEYS){const value=source[key];if(value!==undefined)env[key]=value;}
  env.PATH??='/usr/bin:/bin:/usr/sbin:/sbin';
  return env;
}
