import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('desktop window state', () => {
  it('starts every edition at the default centered size', () => {
    for (const config of [
      'src-tauri/tauri.conf.json',
      'src-tauri/tauri.bundled.conf.json',
      'src-tauri/tauri.lite.conf.json',
    ]) {
      const source = JSON.parse(readFileSync(resolve(config), 'utf8')) as {
        app: { windows: Array<{
          width: number
          height: number
          center: boolean
          create: boolean
          visible: boolean
        }> }
      }
      expect(source.app.windows[0]).toMatchObject({
        width: 720,
        height: 540,
        center: true,
        create: false,
        visible: false,
      })
    }
  })

  it('initializes native state before creating and showing the WebView', () => {
    const native = readFileSync(resolve('src-tauri/src/lib.rs'), 'utf8')
    const setup = native.slice(native.indexOf('.setup(|app|'), native.indexOf('let builder = builder.on_page_load'))

    expect(setup.indexOf('app.manage(AppState::new())'))
      .toBeLessThan(setup.indexOf('WebviewWindowBuilder::from_config'))
    expect(setup).toContain('PageLoadEvent::Finished')
    expect(setup.indexOf('is_bootstrap_url(window.app_handle(), payload.url())'))
      .toBeLessThan(setup.indexOf('window.show()'))
  })

  it('keeps the launch window at its configured default until dsh is ready', () => {
    const launch = readFileSync(resolve('src-tauri/src/app.rs'), 'utf8')

    const navigate = launch.indexOf('.navigate(url)')
    const register = launch.indexOf('tauri_plugin_window_state::Builder::default()')
    const normalize = launch.indexOf('normalize_maximized_restore_position(&dirs.window_state)')
    const restore = launch.indexOf('window.restore_state(window_state_flags())')
    expect(navigate).toBeGreaterThan(-1)
    expect(normalize).toBeGreaterThan(navigate)
    expect(register).toBeGreaterThan(normalize)
    expect(register).toBeGreaterThan(navigate)
    expect(restore).toBeGreaterThan(register)
    expect(launch).toContain('.with_filename(dirs.window_state.to_string_lossy().into_owned())')
    expect(launch).toContain('.skip_initial_state("main")')
    expect(launch).toContain('WindowEvent::Moved(_) | WindowEvent::Resized(_)')
    expect(launch).toContain('WINDOW_STATE_SAVE_DEBOUNCE')
    expect(launch).toContain('save_window_state_if_ready(app);')
    expect(launch).toContain('StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED')
  })

  it('saves synchronously before shutdown as well as controlled restart', () => {
    const launch = readFileSync(resolve('src-tauri/src/app.rs'), 'utf8')
    const native = readFileSync(resolve('src-tauri/src/lib.rs'), 'utf8')
    const restart = launch.slice(
      launch.indexOf('fn restart_application('),
      launch.indexOf('fn terminate_generation('),
    )

    expect(restart.indexOf('save_window_state_if_ready(app)'))
      .toBeLessThan(restart.indexOf('app.request_restart()'))
    expect(restart.indexOf('save_window_state_if_ready(app)'))
      .toBeLessThan(restart.indexOf('graceful_stop(&mut child, STOP_GRACE)'))
    expect(native).toContain('app::save_window_state_if_ready(app);')
  })
})
