import { targetInfo } from './targets.mjs'

const DIGEST_PATTERN = /^[a-f0-9]{64}$/u

/**
 * 校验 App 插件载荷与启动清单属于同一 edition 和目标三元组。
 * platform 只描述插件筛选平台，不能代替 targetTriple。
 */
export function assertPluginPayloadIdentity({ bootstrap, payload, payloadIndex }) {
  if (
    bootstrap?.schemaVersion !== 1
    || payload?.schemaVersion !== 2
    || payloadIndex?.schemaVersion !== 1
  ) {
    throw new Error('runtime plugin payload manifest is invalid')
  }
  const expectedPlatform = targetInfo(bootstrap.app?.target).appTarget
  if (
    payload.edition !== bootstrap.app?.edition
    || payload.platform !== expectedPlatform
    || payload.targetTriple !== bootstrap.app?.target
  ) {
    throw new Error('runtime plugin payload target does not match the app')
  }
  if (
    !DIGEST_PATTERN.test(payload.digest)
    || payload.digest !== bootstrap.pluginDigest
  ) {
    throw new Error('runtime plugin payload digest does not match the app')
  }
  if (!Array.isArray(payload.plugins) || !Array.isArray(payloadIndex.plugins)) {
    throw new Error('runtime plugin payload is incomplete')
  }
  const payloadContract = payload.plugins.map(plugin => `${String(plugin?.id)}\0${String(plugin?.entry)}`)
  const indexContract = payloadIndex.plugins.map(plugin => `${String(plugin?.id)}\0${String(plugin?.entry)}`)
  if (JSON.stringify(payloadContract) !== JSON.stringify(indexContract)) {
    throw new Error('runtime plugin payload index does not match its manifest')
  }
}
