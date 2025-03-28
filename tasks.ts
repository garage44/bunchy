import {broadcast, settings, tooling} from './index.ts'
import {Task} from './task.ts'
import chokidar from 'chokidar'
import fg from 'fast-glob'
import fs from 'fs-extra'
import {glob} from 'glob'
import path from 'path'
import template from 'lodash.template'
import {throttle} from '@garage44/common/lib/utils'

const debounce = {options: {trailing: true}, wait: 1000}

function getExternalsFromPackageJson() {
    const packageJson = JSON.parse(fs.readFileSync("./package.json"))

    const sections = [
        'dependencies',
        'devDependencies',
        'peerDependencies',
    ].sort()

    const externals = new Set<string>()

    for (const section of sections) {
        if (packageJson[section]) {
            Object.keys(packageJson[section]).forEach(dep => {
                externals.add(dep)
            })
        }
    }

    return Array.from(externals) as string[]
}

const runner = {
    assets: throttle(async() => {
        const result = await tasks.assets.start()
        if (settings.reload_ignore.includes('/tasks/assets')) return
        broadcast('/tasks/assets', result || {}, 'POST')
    }, debounce.wait, debounce.options),
    code_backend: throttle(async() => {
        const {filename, size} = await tasks.code_backend.start({minify: false, sourceMap: true})
        if (settings.reload_ignore.includes('/tasks/code_backend')) return
        broadcast('/tasks/code_backend', {
            filename,
            publicPath: path.relative(settings.dir.workspace, settings.dir.public),
            size,
        }, 'POST')
    }, debounce.wait, debounce.options),
    code_frontend: throttle(async() => {
        const {filename, size} = await tasks.code_frontend.start({minify: false, sourceMap: true})
        if (settings.reload_ignore.includes('/tasks/code_frontend')) return
        broadcast('/tasks/code_frontend', {
            filename,
            publicPath: path.relative(settings.dir.workspace, settings.dir.public),
            size,
        }, 'POST')
    }, debounce.wait, debounce.options),
    html: throttle(async() => {
        const {filename, size} = await tasks.html.start({minify: false})
        if (settings.reload_ignore.includes('/tasks/html')) return
        broadcast('/tasks/html', {
            filename,
            publicPath: path.relative(settings.dir.workspace, settings.dir.public),
            size,
        }, 'POST')
    }, debounce.wait, debounce.options),
    styles: {
        app: throttle(async() => {
            const [{filename, size}] = await Promise.all([
                tasks.stylesApp.start({minify: false, sourceMap: true}),
                tasks.stylesComponents.start({minify: false, sourceMap: true}),
            ])
            if (settings.reload_ignore.includes('/tasks/styles/app')) return
            broadcast('/tasks/styles/app', {
                filename,
                publicPath: path.relative(settings.dir.workspace, settings.dir.public),
                size,
            }, 'POST')
        }, debounce.wait, debounce.options),
        components: throttle(async() => {
            const {filename, size} = await tasks.stylesComponents.start({minify: false, sourceMap: true})
            if (settings.reload_ignore.includes('/tasks/styles/components')) return
            broadcast('/tasks/styles/components', {
                filename,
                publicPath: path.relative(settings.dir.workspace, settings.dir.public),
                size,
            }, 'POST')
        }, debounce.wait, debounce.options),
    },
}

// Add this interface before the tasks declaration
interface Tasks {
    assets: Task;
    build: Task;
    clean: Task;
    code_backend: Task;
    code_frontend: Task;
    dev: Task;
    html: Task;
    styles: Task;
    stylesApp: Task;
    stylesComponents: Task;
    [key: string]: Task;
}

// Update the tasks declaration
export const tasks: Tasks = {} as Tasks

tasks.assets = new Task('assets', async function() {
    await fs.ensureDir(path.join(settings.dir.public, 'fonts'))

    const actions = [
        fs.copy(path.join(settings.dir.assets, 'fonts'), path.join(settings.dir.public, 'fonts')),
        fs.copy(path.join(settings.dir.assets, 'img'), path.join(settings.dir.public, 'img')),
    ]

    await Promise.all(actions)
})

tasks.build = new Task('build', async function({minify = false, sourceMap = false} = {}) {
    await tasks.clean.start()
    await Promise.all([
        tasks.assets.start(),
        tasks.html.start({minify}),
        tasks.code_backend.start({minify, sourceMap}),
        tasks.code_frontend.start({minify, sourceMap}),
        tasks.styles.start({minify, sourceMap}),
    ])
})

tasks.clean = new Task('clean', async function() {
    await fs.rm(path.join(settings.dir.workspace, 'app.js'), {force: true})
    await fs.rm(settings.dir.public, {force: true, recursive: true})
    await fs.mkdirp(settings.dir.public)
})

tasks.code_backend = new Task('code:backend', async function({minify = false, sourceMap = false} = {}) {
    const external = getExternalsFromPackageJson()

    try {
        const result = await Bun.build({
            define: {
                'process.env.BUN_ENV': '"production"',
            },
            entrypoints: [path.join(settings.dir.workspace, 'service.ts')],
            external,
            format: 'esm',
            minify: {
                identifiers: false,
                syntax: false,
                whitespace: minify,
            },
            naming: `[dir]/[name].js`,
            outdir: settings.dir.workspace,
            sourcemap: 'none',
            target: 'node',
        })
        if (!result.success) {
            // eslint-disable-next-line no-console
            console.error(result.logs)
        }
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error(error)
    }

    const filename = `service.js`
    return {
        filename,
        size: (await fs.readFile(path.join(settings.dir.workspace, filename))).length,
    }
})

tasks.code_frontend = new Task('code:frontend', async function({minify = false, sourceMap = false} = {}) {
    try {
        const result = await Bun.build({
            define: {
                'process.env.NODE_ENV': `'${process.env.NODE_ENV}'`,
            },
            entrypoints: [path.join(settings.dir.src, 'app.ts')],
            format: 'esm',
            minify: {
                identifiers: false,
                syntax: minify,
                whitespace: minify,
            },
            naming: `[dir]/[name].${settings.buildId}.[ext]`,
            outdir: settings.dir.public,
            sourcemap: process.env.NODE_ENV === 'production' ? 'none' : 'inline',
        })
        if (!result.success) {
            // eslint-disable-next-line no-console
            console.error(result.logs)
        }
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error(error)
    }

    const filename = `app.${settings.buildId}.js`
    return {
        filename,
        size: (await fs.readFile(path.join(settings.dir.public, filename))).length,
    }
})

tasks.dev = new Task('dev', async function({minify = false, sourceMap = true} = {}) {
    await tasks.build.start({minify, sourceMap})

    const files_assets = await glob([
        path.join(settings.dir.assets, 'manifest.json'),
        path.join(settings.dir.assets, 'img', '**'),
        path.join(settings.dir.assets, 'fonts', '**'),
    ])
    chokidar.watch(files_assets).on('change', runner.assets)

    chokidar.watch([path.join(settings.dir.src, 'index.html')]).on('change', runner.html)

    const files_code_frontend = await glob([
        path.join(settings.dir.src, '**', '*.ts'),
        path.join(settings.dir.src, '**', '*.tsx'),
        path.join(settings.dir.common, '**', '*.{ts,tsx}'),
    ])
    chokidar.watch(files_code_frontend).on('change', runner.code_frontend)

    const file_code_backend = await glob([
        path.join(settings.dir.workspace, 'app.ts'),
        path.join(settings.dir.workspace, 'api', '**', '*.ts'),
        path.join(settings.dir.workspace, 'lib', '**', '*.ts'),
        path.join(settings.dir.common, '**', '*.ts'),
    ])
    chokidar.watch(file_code_backend).on('change', runner.code_backend)

    const src_styles = await glob([path.join(settings.dir.src, '**', '*.scss')])
    chokidar.watch(src_styles).on('change', runner.styles.app)

    const files_styles = await glob([
        path.join(settings.dir.components, '**', '*.scss'),
        path.join(settings.dir.common, '**', '*.scss'),
    ])
    chokidar.watch(files_styles).on('change', runner.styles.components)
})

tasks.html = new Task('html', async function() {
    const indexFile = await fs.readFile(path.join(settings.dir.src, 'index.html'))
    const html = template(indexFile)({settings})
    const filename = 'index.html'
    await fs.writeFile(path.join(settings.dir.public, filename), html)
    return {filename, size: html.length}
})

tasks.styles = new Task('styles', async function({minify = false, sourceMap = false} = {}) {
    const actions = [
        tasks.stylesApp.start({minify, sourceMap}),
        tasks.stylesComponents.start({minify, sourceMap}),
    ]

    const res = await Promise.all(actions)
    return {size: res.reduce((total, result) => total + result.size, 0)}
})

tasks.stylesApp = new Task('styles:app', async function({minify, sourceMap}) {
    let data = `
    @use "sass:color";
    @use "sass:math";
    @use "variables" as *;
    `
    data += await fs.readFile(path.join(settings.dir.src, 'scss', 'app.scss'), 'utf8')
    const filename =`app.${settings.buildId}.css`
    const styles = await tooling.scss({
        data,
        file: 'scss/app.scss',
        minify,
        outFile: path.join(settings.dir.public, filename),
        sourceMap,
    })

    return {filename, size: styles.length}
})

tasks.stylesComponents = new Task('styles:components', async function({minify, sourceMap}) {
    let data = `
        @use "sass:color";
        @use "sass:math";
        @use "variables" as *;
    `

    const imports = await Promise.all([
        fg('**/*.scss', {
            absolute: true,
            cwd: settings.dir.components,
        }),
        fg('**/*.scss', {
            absolute: true,
            cwd: path.join(settings.dir.common),
        }),
    ])

    const allImports = imports.flat()

    const componentImports = allImports.map((f) => {
        const scssImport = f.replace(`${settings.dir.components}${path.sep}`, '').replace('.scss', '')
        const namespace = scssImport.replace(/\//g, '-').replace(/\./g, '-').replace('@', '')
        return `@use "${scssImport}" as ${namespace};`
    })

    data += componentImports.join('\n')
    const filename = `components.${settings.buildId}.css`
    const styles = await tooling.scss({
        data,
        file: 'src/scss/components.scss',
        minify,
        outFile: path.join(settings.dir.public, filename),
        sourceMap,
    })

    return {filename, size: styles.length}
})
