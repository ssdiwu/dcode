import { createHmac, randomBytes } from 'node:crypto';
import { createModels } from '@earendil-works/pi-ai/models';
import type { AnyModel, ClassifierOptions, CredentialStore, Provider } from '@earendil-works/pi-ai';
import { NO_AMBIENT_CONTEXT } from './preset-providers';

type TypedAuthOptions = Pick<ClassifierOptions, 'apiKey' | 'headers' | 'env' | 'signal'>;
const key = randomBytes(32);
const ordered = (value: Record<string, string | null | undefined> | undefined, lower = false) => Object.entries(value ?? {})
  .filter(([, value]) => value !== undefined && value !== null).map(([name, value]) => [lower ? name.toLowerCase() : name, value])
  .sort(([a], [b]) => String(a).localeCompare(String(b)));
const fingerprint = (model: AnyModel, options: TypedAuthOptions) => createHmac('sha256', key)
  .update(JSON.stringify([model.provider, model.id, model.api, model.baseUrl, options.apiKey,
    ordered(options.headers, true), ordered(options.env)])).digest('hex');

/** SDK已准备认证、App额度await之后再读同一自管存储；不刷新OAuth、不回写或替换旧请求身份。 */
export async function confirmTypedAuth(provider: Provider, credentials: CredentialStore, canonical: AnyModel,
  prepared: AnyModel, options: TypedAuthOptions): Promise<boolean> {
  const readonly: CredentialStore = {
    read: (id, opts) => credentials.read(id, opts), list: opts => credentials.list(opts),
    modify: async () => { throw new Error('只读认证核对不能刷新凭据'); },
    delete: async () => { throw new Error('只读认证核对不能写凭据'); },
  };
  const models = createModels({ credentials: readonly, authContext: NO_AMBIENT_CONTEXT }); models.setProvider(provider);
  try {
    const fresh = await models.getAuth(canonical, { signal: options.signal });
    return !!fresh && fingerprint(prepared, options) === fingerprint(
      fresh.auth.baseUrl ? { ...canonical, baseUrl: fresh.auth.baseUrl } : canonical,
      { apiKey: fresh.auth.apiKey, headers: fresh.auth.headers, env: fresh.env });
  } catch { return false; }
}
