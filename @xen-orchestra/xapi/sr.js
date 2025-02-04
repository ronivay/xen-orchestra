'use strict'

const { asyncMap, asyncMapSettled } = require('@xen-orchestra/async-map')
const { decorateClass } = require('@vates/decorate-with')
const { defer } = require('golike-defer')
const { incorrectState } = require('xo-common/api-errors')
const { VDI_FORMAT_VHD } = require('./index.js')
const assert = require('node:assert').strict
const peekFooterFromStream = require('vhd-lib/peekFooterFromVhdStream')

const AggregateError = require('./_AggregateError.js')

const { warn } = require('@xen-orchestra/log').createLogger('xo:xapi:sr')

const OC_MAINTENANCE = 'xo:maintenanceState'

class Sr {
  async create({
    content_type = 'user', // recommended by Citrix
    device_config,
    host,
    name_description = '',
    name_label,
    physical_size = 0,
    shared,
    sm_config = {},
    type,
  }) {
    const ref = await this.call(
      'SR.create',
      host,
      device_config,
      physical_size,
      name_label,
      name_description,
      type,
      content_type,
      shared,
      sm_config
    )

    // https://developer-docs.citrix.com/projects/citrix-hypervisor-sdk/en/latest/xc-api-extensions/#sr
    this.setFieldEntry('SR', ref, 'other_config', 'auto-scan', 'true').catch(warn)

    return ref
  }

  // Switch the SR to maintenance mode:
  // - shutdown all running VMs with a VDI on this SR
  //   - their UUID is saved into SR.other_config[OC_MAINTENANCE].shutdownVms
  //   - clean shutdown is attempted, and falls back to a hard shutdown
  // - unplug all connected hosts from this SR
  async enableMaintenanceMode($defer, ref, { vmsToShutdown = [] } = {}) {
    const state = { timestamp: Date.now() }

    // will throw if already in maintenance mode
    await this.call('SR.add_to_other_config', ref, OC_MAINTENANCE, JSON.stringify(state))

    await $defer.onFailure.call(this, 'call', 'SR.remove_from_other_config', ref, OC_MAINTENANCE)

    const runningVms = new Map()
    const handleVbd = async ref => {
      const vmRef = await this.getField('VBD', ref, 'VM')
      if (!runningVms.has(vmRef)) {
        const power_state = await this.getField('VM', vmRef, 'power_state')
        const isPaused = power_state === 'Paused'
        if (isPaused || power_state === 'Running') {
          runningVms.set(vmRef, isPaused)
        }
      }
    }
    await asyncMap(await this.getField('SR', ref, 'VDIs'), async ref => {
      await asyncMap(await this.getField('VDI', ref, 'VBDs'), handleVbd)
    })

    {
      const runningVmUuids = await asyncMap(runningVms.keys(), ref => this.getField('VM', ref, 'uuid'))

      const set = new Set(vmsToShutdown)
      for (const vmUuid of runningVmUuids) {
        if (!set.has(vmUuid)) {
          throw incorrectState({
            actual: vmsToShutdown,
            expected: runningVmUuids,
            property: 'vmsToShutdown',
          })
        }
      }
    }

    state.shutdownVms = {}

    await asyncMapSettled(runningVms, async ([ref, isPaused]) => {
      state.shutdownVms[await this.getField('VM', ref, 'uuid')] = isPaused

      try {
        await this.callAsync('VM.clean_shutdown', ref)
      } catch (error) {
        warn('SR_enableMaintenanceMode, VM clean shutdown', { error })
        await this.callAsync('VM.hard_shutdown', ref)
      }

      $defer.onFailure.call(this, 'callAsync', 'VM.start', ref, isPaused, true)
    })

    state.unpluggedPbds = []
    await asyncMapSettled(await this.getField('SR', ref, 'PBDs'), async ref => {
      if (await this.getField('PBD', ref, 'currently_attached')) {
        state.unpluggedPbds.push(await this.getField('PBD', ref, 'uuid'))

        await this.callAsync('PBD.unplug', ref)

        $defer.onFailure.call(this, 'callAsync', 'PBD.plug', ref)
      }
    })

    await this.setFieldEntry('SR', ref, 'other_config', OC_MAINTENANCE, JSON.stringify(state))
  }

  // this method is best effort and will not stop on first error
  async disableMaintenanceMode(ref) {
    const state = JSON.parse((await this.getField('SR', ref, 'other_config'))[OC_MAINTENANCE])

    // will throw if not in maintenance mode
    await this.call('SR.remove_from_other_config', ref, OC_MAINTENANCE)

    const errors = []

    await asyncMap(state.unpluggedPbds, async uuid => {
      try {
        await this.callAsync('PBD.plug', await this.call('PBD.get_by_uuid', uuid))
      } catch (error) {
        errors.push(error)
      }
    })

    await asyncMap(Object.entries(state.shutdownVms), async ([uuid, isPaused]) => {
      try {
        await this.callAsync('VM.start', await this.call('VM.get_by_uuid', uuid), isPaused, true)
      } catch (error) {
        errors.push(error)
      }
    })

    if (errors.length !== 0) {
      throw new AggregateError(errors)
    }
  }

  async importVdi(
    $defer,
    ref,
    stream,
    {
      format = VDI_FORMAT_VHD,
      name_label = '[XO] Imported disk - ' + new Date().toISOString(),
      virtual_size,
      ...vdiCreateOpts
    } = {}
  ) {
    if (virtual_size === undefined) {
      if (format === VDI_FORMAT_VHD) {
        const footer = await peekFooterFromStream(stream)
        virtual_size = footer.currentSize
      } else {
        virtual_size = stream.length
        assert.notEqual(virtual_size, undefined)
      }
    }

    const vdiRef = await this.VDI_create({ ...vdiCreateOpts, name_label, SR: ref, virtual_size })
    $defer.onFailure.call(this, 'callAsync', 'VDI.destroy', vdiRef)
    await this.VDI_importContent(vdiRef, stream, { format })
    return vdiRef
  }
}
module.exports = Sr

decorateClass(Sr, { enableMaintenanceMode: defer, importVdi: defer })
