// Entry point. Stands in for the Godot autoloads (Rhythia.cs, SceneManager.cs, KeybindsManager.cs, SettingsManager,
// SkinManager, MapManager, SoundManager) and wires every scene together.

import { SoundManager, decodeAudio, resumeAudio } from './audio.js';
import { GameScene } from './game/game.js';
import { Replay } from './game/replay.js';
import { Lobby } from './lobby.js';
import { MapManager } from './map/manager.js';
import { isValidExt } from './map/parser.js';
import { RenderBackend, TIME } from './render.js';
import { SettingsManager, SettingsProfile } from './settings.js';
import { SkinManager } from './skin.js';
import { createSpace } from './spaces/index.js';
import { Stats } from './stats.js';
import { Storage } from './storage.js';
import { Trans, baseName, downloadBytes, extOf, pickFiles, tween, updateTweens } from './util.js';
import { OptionPopup, Overlays, linkPopup, notify } from './ui/common.js';
import { LoadingScene } from './ui/loading.js';
import { MainMenu } from './ui/mainMenu.js';
import { ResultsScene } from './ui/results.js';
import { SettingsMenu } from './ui/settingsMenu.js';

const app = {
    settingsManager: SettingsManager,
    skinManager: SkinManager,
    mapManager: MapManager,
    sound: SoundManager,
    stats: Stats,
    lobby: Lobby,
    notify,
    mouse: { x: window.innerWidth / 2, y: window.innerHeight / 2 },
};
window.rhythia = app; // handy for debugging from the console

// ---------------------------------------------------------------- SceneManager

class SceneManagerClass {
    constructor() {
        this.root = document.getElementById('scenes');
        this.transition = document.createElement('div');
        this.transition.className = 'scene-transition';
        document.body.appendChild(this.transition);
        this.transition.style.zIndex = 60;
        this.scenes = {};
        this.scene = null;
        this.space = null;
        this.spaceName = null;
        this.activeName = null;
        this.loading = false;
    }

    get(name) {
        if (name === 'results') return new ResultsScene(app); // results is recreated every time like the original
        if (!this.scenes[name]) {
            this.scenes[name] =
                name === 'loading' ? new LoadingScene(app) : name === 'menu' ? new MainMenu(app) : name === 'game' ? new GameScene(app) : null;
        }
        return this.scenes[name];
    }

    reloadCurrentScene() {
        this.load(this.activeName, true);
    }

    load(name, skipTransition = false) {
        const next = this.get(name);
        const fadeOut = () =>
            new Promise((resolve) => {
                if (!this.scene || skipTransition) return resolve();
                tween((a) => (this.transition.style.opacity = a), Number(this.transition.style.opacity || 0), 1, 0.25, { trans: Trans.QUAD, onDone: resolve });
            });

        this.loadToken = (this.loadToken ?? 0) + 1;
        const token = this.loadToken;

        fadeOut().then(async () => {
            if (token !== this.loadToken) return;
            this.transition.style.opacity = 1;
            const old = this.scene;
            if (old) {
                old.unload?.();
                old.element.remove();
            }
            this.activeName = name;
            this.scene = next;

            await this.updateSpace(next);
            this.root.appendChild(next.element);
            try {
                await next.load();
            } catch (e) {
                console.error(e);
            }
            SoundManager.refreshMenuMusicPlayback();
            tween((a) => (this.transition.style.opacity = a), 1, 0, skipTransition ? 0 : 0.25, { trans: Trans.QUAD });
        });
    }

    async updateSpace(scene, force = false) {
        const skin = SkinManager.skin;
        const wanted = scene.useGameSpace ? skin.gameSpace : scene.useMenuSpace ? skin.menuSpace : null;
        if (!force && this.space && this.spaceName === wanted && this.spaceFor === (scene.useGameSpace ? 'game' : 'menu')) {
            this.space.updateState(!!scene.useGameSpace);
            return;
        }
        this.space?.dispose();
        this.space = null;
        this.spaceName = wanted;
        this.spaceFor = scene.useGameSpace ? 'game' : 'menu';
        if (!wanted) return;
        const ctx = {
            settings: SettingsManager.settings,
            skin,
            mouse: app.mouse,
            game: () => (this.scene instanceof GameScene ? GameScene.attempt : null),
        };
        // the menu space is created as "not playing" so it runs its intro animation
        this.space = await createSpace(wanted, ctx);
        this.space.updateState(!!scene.useGameSpace);
        const map = MapManager.selected.value;
        if (map && !scene.useGameSpace) this.space.updateMap(map, await MapManager.getCoverUrl(map));
    }
}

// ---------------------------------------------------------------- app helpers

const audioCache = new Map();
async function decodeMapAudioByName(name, bytesLoader) {
    if (audioCache.has(name)) return audioCache.get(name);
    const bytes = await bytesLoader();
    const buffer = bytes ? await decodeAudio(bytes) : null;
    audioCache.set(name, buffer);
    if (audioCache.size > 8) audioCache.delete(audioCache.keys().next().value);
    return buffer;
}

app.decodeMapAudio = (map) => decodeMapAudioByName(map.name, async () => map.audioBuffer ?? (await MapManager.getAudio(map)));
SoundManager.loadMapAudio = (map) => decodeMapAudioByName(map.name, () => MapManager.getAudio(map));
SoundManager.getMaps = () => MapManager.maps;
SoundManager.isMainMenu = () => app.sceneManager?.scene instanceof MainMenu;
SoundManager.sceneName = () => app.sceneManager?.scene?.name ?? '';
SoundManager.speed = () => Lobby.speed;

MapManager.notify = notify;
SkinManager.notify = notify;

app.selectMap = (map) => {
    MapManager.select(map);
    Lobby.setMap(MapManager.selected.value);
    MapManager.getCoverUrl(map).then((url) => app.sceneManager.space?.updateMap(map, url));
    SoundManager.startMapSelectionPlayback(map);
    app.sceneManager.scenes.menu?.mapInfo.select(map);
};

app.focusMap = (map) => {
    const menu = app.sceneManager.scenes.menu;
    if (menu) menu.mapList.select(map, false);
};

app.playSelected = () => {
    if (!Lobby.map) return;
    GameScene.play(app, Lobby.map, Lobby.speed, Lobby.startFrom, Lobby.cameraMode, Lobby.modifiers);
};

app.playReplay = async (replay) => {
    if (!replay.valid) return;
    const map = MapManager.getMapByName(replay.mapID);
    if (!map) return notify('Replay map not found', 2);
    SoundManager.song.stop();
    await GameScene.play(app, map, replay.speed, replay.startFrom, replay.cameraMode, replay.modifiers, null, [replay]);
};

app.playReplayById = async (id) => {
    const bytes = await Storage.get('replays', id);
    if (!bytes) return;
    await app.playReplay(new Replay(id, bytes, (name) => !!MapManager.getMapByName(name), notify));
};

app.importFiles = async (files) => {
    const maps = [];
    const replays = [];
    const mapLike = files.filter((f) => isValidExt(extOf(f.name)) || ['mp3', 'ogg', 'wav'].includes(extOf(f.name)));
    if (mapLike.some((f) => isValidExt(extOf(f.name)))) {
        const imported = await MapManager.bulkImport(mapLike, true);
        maps.push(...imported);
        SoundManager.updateJukeboxQueue();
        const menu = app.sceneManager.scene;
        if (menu instanceof MainMenu) {
            menu.transition('play');
            menu.mapList.updateMaps();
            if (imported.length) menu.mapList.select(MapManager.getMapByName(imported[0].name), false);
        }
    }
    for (const f of files.filter((f) => extOf(f.name) === 'phxr')) {
        const bytes = new Uint8Array(await f.arrayBuffer());
        const id = baseName(f.name);
        const replay = new Replay(id, bytes, (name) => !!MapManager.getMapByName(name), notify);
        if (replay.valid) {
            await Storage.put('replays', id, bytes);
            replays.push(replay);
        }
    }
    if (replays.length > 0) app.playReplay(replays[0]);
};

app.quit = async () => {
    await saveAll();
    notify('Saved. You can close this tab now.');
    SoundManager.song.stop();
    SoundManager.menuMusic.stop();
};

async function saveAll() {
    Stats.TotalPlaytime += Math.floor((performance.now() - startedAt) / 1000);
    startedAt = performance.now();
    SettingsManager.save();
    await Stats.save();
}

// "User Folder": full backup of the browser storage as a zip, and restore
app.exportUserData = async () => {
    const zip = new globalThis.JSZip();
    for (const store of Storage.STORES) {
        for (const [key, value] of await Storage.all(store)) {
            const path = `${store}/${encodeURIComponent(String(key))}`;
            if (value instanceof Uint8Array) zip.file(path, value);
            else zip.file(`${path}.json`, JSON.stringify(value));
        }
    }
    for (const name of SettingsManager.getProfiles()) {
        try {
            const json = localStorage.getItem(`rhythia.profiles.${name}`);
            if (json) zip.file(`profiles/${name}.json`, json);
        } catch {}
    }
    zip.file('current_profile.txt', SettingsManager.getCurrentProfile());
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    downloadBytes(bytes, 'Rhythia-user.zip');
};

app.importUserData = async () => {
    const [file] = await pickFiles({ accept: '.zip', multiple: false });
    if (!file) return;
    const zip = await globalThis.JSZip.loadAsync(await file.arrayBuffer());
    for (const entry of Object.values(zip.files)) {
        if (entry.dir) continue;
        const [store, ...rest] = entry.name.split('/');
        if (store === 'profiles') {
            SettingsManager.saveJson(rest.join('/').replace(/\.json$/, ''), await entry.async('string'));
        } else if (Storage.STORES.includes(store)) {
            const raw = rest.join('/');
            if (raw.endsWith('.json')) await Storage.put(store, decodeURIComponent(raw.slice(0, -5)), JSON.parse(await entry.async('string')));
            else await Storage.put(store, decodeURIComponent(raw), await entry.async('uint8array'));
        }
    }
    notify('Imported user folder, reloading...');
    setTimeout(() => location.reload(), 1000);
};

// ---------------------------------------------------------------- settings hooks

async function reloadSkin() {
    await SkinManager.load();
    await SoundManager.updateSkin(SkinManager.skin);
    app.menuCursor.updateCursorSkin(SkinManager.url('cursorImage'), SettingsManager.settings.CursorScale.value);
    const scene = app.sceneManager?.scene;
    if (scene && (scene.useMenuSpace || scene.useGameSpace)) await app.sceneManager.updateSpace(scene, true);
}

function importNightlyProfile(text) {
    const root = JSON.parse(text);
    const get = (k) => (root[k] === undefined ? null : root[k]);
    const profile = new SettingsProfile({});
    const importVolume = (key, range) => {
        const channelDb = get(key);
        if (channelDb == null) return 50;
        const masterDb = get('master_volume') ?? 20 * Math.log10(0.5);
        const total = Math.min(0, Math.max(-80, masterDb + channelDb));
        return Math.min(100, Math.max(0, 100 * Math.pow((total + 80) / range, 10)));
    };
    const or = (v, item) => (v == null ? profile[item].value : v);
    const conv = {
        Sensitivity: get('sensitivity') != null ? get('sensitivity') * 2.16 * (70 / (get('fov') ?? 70)) : null,
        AbsoluteSensitivity: get('absolute_scale'),
        AbsoluteInput: get('absolute_mode'),
        CursorDrift: get('enable_drift_cursor'),
        ApproachRate: get('approach_rate'),
        ApproachDistance: get('spawn_distance'),
        Pushback: get('do_note_pushback'),
        CameraParallax: get('parallax') != null ? get('parallax') * 0.025 : null,
        HUDParallax: get('ui_parallax') != null ? get('ui_parallax') * 0.025 : null,
        FoV: get('fov'),
        NoteColors: get('selected_colorset'),
        NoteMesh: get('selected_mesh'),
        NoteSize: get('note_size') != null ? get('note_size') * 0.875 : null,
        NoteOpacity: get('note_opacity'),
        CursorScale: get('cursor_scale'),
        CursorRotation: get('cursor_spin'),
        CursorTrail: get('cursor_trail'),
        TrailTime: get('trail_time'),
        TrailDetail: get('trail_detail'),
        SimpleHUD: get('simple_hud'),
        HitPopups: get('score_popup'),
        MissPopups: get('show_miss_effect'),
        Fullscreen: get('window_fullscreen'),
        FPS: get('target_fps'),
        VolumeMaster: 100,
        VolumeMusic: importVolume('music_volume', 70),
        VolumeHitSound: importVolume('hit_volume', 80),
        VolumeMissSound: importVolume('miss_volume', 80),
        VolumeSFX: importVolume('fail_volume', 80),
        EnableHitSound: get('play_hit_snd'),
        EnableMissSound: get('play_miss_snd'),
        EnableMenuMusic: get('play_menu_music'),
        AutoplayJukebox: get('auto_preview_song'),
        LocalOffset: get('music_offset'),
        RecordReplays: get('record_replays'),
    };
    for (const [prop, v] of Object.entries(conv)) profile[prop].value = or(v, prop);

    let name = 'nightly';
    for (let i = 1; SettingsManager.profileExists(name); i++) name = `nightly-${i}`;
    SettingsManager.saveJson(name, profile.serialize());
    SettingsManager.setCurrentProfile(name);
    SettingsManager.load(name);
    app.settingsMenu.updateProfileSelection();
    notify(`Created profile '${name}'`);
}

SettingsManager.setHooks({
    notify,
    reloadSkin: () => reloadSkin(),
    updateVolume: () => SoundManager.updateVolume(),
    refreshMenuMusic: () => SoundManager.refreshMenuMusicPlayback(),
    antiAliasing: (v) => app.backend?.setAntiAliasing(v),
    menuCursor: (v) => {
        const scene = app.sceneManager?.scene;
        if (scene && !(scene instanceof GameScene)) app.menuCursor?.updateVisible(v);
    },
    fullscreen: (v, init) => {
        if (init) return;
        if (v && !document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
        else if (!v && document.fullscreenElement) document.exitFullscreen?.();
    },
    openSkinFolder: () => notify('Skins are read from user/skins in the browser build', 1),
    exportUserData: () => app.exportUserData(),
    importUserData: () => app.importUserData(),
    importNightly: async () => {
        const [file] = await pickFiles({ accept: '.json', multiple: false });
        if (!file) return notify('Nightly settings not found, choose the settings file manually.');
        try {
            importNightlyProfile(await file.text());
        } catch (e) {
            console.error(e);
            notify('Settings file corrupted', 2);
        }
    },
    importMeshes: async () => {
        const files = await pickFiles({ accept: '.obj,.mtl', multiple: true });
        let count = 0;
        for (const f of files.filter((f) => extOf(f.name) === 'obj')) {
            const name = baseName(f.name);
            if (await Storage.exists('meshes', name)) continue;
            await Storage.put('meshes', name, await f.text());
            count++;
        }
        await SkinManager.refreshUserContent();
        app.settingsMenu.refreshList(SettingsManager.settings.NoteMesh);
        notify(`Imported ${count} meshes from nightly`);
    },
    importColorsets: async () => {
        const files = await pickFiles({ accept: '.txt', multiple: true });
        let count = 0;
        for (const f of files) {
            const name = baseName(f.name);
            if (await Storage.exists('colorsets', name)) continue;
            await Storage.put('colorsets', name, await f.text());
            count++;
        }
        await SkinManager.refreshUserContent();
        app.settingsMenu.refreshList(SettingsManager.settings.NoteColors);
        notify(`Imported ${count} colorsets from nightly`);
    },
    resetToDefaults: () => SettingsManager.resetToDefaults(),
});

// ---------------------------------------------------------------- input

function bindInput() {
    const sm = app.sceneManager;

    document.addEventListener('mousemove', (e) => {
        app.mouse.x = e.clientX;
        app.mouse.y = e.clientY;
        if (sm.scene instanceof GameScene) sm.scene.onMouseMove(e);
    });

    // Touch handling: convert finger movement into movementX/movementY and forward to GameScene.onMouseMove.
    // Use non-passive listeners and disable default touch actions so we can prevent scrolling.
    try {
        const canvas = app.backend?.canvas;
        if (canvas) {
            canvas.style.touchAction = 'none';
            let lastTouch = null;
            canvas.addEventListener(
                'touchstart',
                (ev) => {
                    const t = ev.touches[0];
                    if (!t) return;
                    lastTouch = { x: t.clientX, y: t.clientY };
                    ev.preventDefault();
                },
                { passive: false },
            );
            canvas.addEventListener(
                'touchmove',
                (ev) => {
                    const t = ev.touches[0];
                    if (!t) return;
                    const dx = t.clientX - (lastTouch?.x ?? t.clientX);
                    const dy = t.clientY - (lastTouch?.y ?? t.clientY);
                    lastTouch = { x: t.clientX, y: t.clientY };
                    // Create a synthetic event shape expected by onMouseMove
                    const se = { movementX: dx, movementY: dy, clientX: t.clientX, clientY: t.clientY, target: canvas };
                    if (sm.scene instanceof GameScene) sm.scene.onMouseMove(se);
                    ev.preventDefault();
                },
                { passive: false },
            );
            canvas.addEventListener('touchend', () => (lastTouch = null), { passive: false });
        }
    } catch (e) {
        console.error('Touch handler setup failed', e);
    }

    document.addEventListener('mousedown', (e) => {
        resumeAudio();
        maybeFullscreen(e);
        sm.scene?.onMouseDown?.(e);
    });
    document.addEventListener('contextmenu', (e) => e.preventDefault());

    document.addEventListener(
        'wheel',
        (e) => {
            if (app.overlays.onWheel(e)) e.preventDefault();
        },
        { passive: false },
    );

    document.addEventListener('pointerlockchange', () => {
        if (sm.scene instanceof GameScene) sm.scene.onPointerLockChange();
    });

    document.addEventListener('keydown', (e) => {
        resumeAudio();
        const settings = SettingsManager.settings;

        // KeybindsManager
        if (e.code === 'F1') {
            e.preventDefault();
            if (!(sm.scene instanceof GameScene && sm.scene.runner?.playing)) {
                app.wikiPopup ??= linkPopup('https://wiki.rhythia.net');
                app.wikiPopup.show(!app.wikiPopup.shown);
            }
            return;
        }
        if (e.code === 'F11' || (e.altKey && (e.code === 'Enter' || e.code === 'NumpadEnter'))) {
            e.preventDefault();
            settings.Fullscreen.value = !document.fullscreenElement;
            return;
        }
        if (e.ctrlKey && e.code === 'KeyM') {
            e.preventDefault();
            if (app.volumeBeforeMute == null) {
                app.volumeBeforeMute = settings.VolumeMaster.value;
                settings.VolumeMaster.value = 0;
            } else {
                settings.VolumeMaster.value = app.volumeBeforeMute;
                app.volumeBeforeMute = null;
            }
            SoundManager.updateVolume();
            return;
        }

        if (e.code === 'Escape' && SettingsManager.shown && !(sm.scene instanceof GameScene)) {
            app.settingsMenu.hideMenu();
            return;
        }
        if (e.code === 'Escape' && OptionPopup.hideTop()) return;
        if (e.ctrlKey && e.code === 'KeyO' && !(sm.scene instanceof MainMenu)) {
            e.preventDefault();
            app.settingsMenu.toggle();
            return;
        }

        if (['Space', 'ArrowUp', 'ArrowDown', 'Tab', 'F2', 'F3', 'Backquote'].includes(e.code) && document.activeElement?.tagName !== 'INPUT') {
            e.preventDefault();
        }
        sm.scene?.onKeyDown?.(e);
    });

    // drag & drop import (Rhythia.FilesDropped)
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
        e.preventDefault();
        const files = [...(e.dataTransfer?.files ?? [])];
        if (files.length) app.importFiles(files);
    });

    document.addEventListener('fullscreenchange', () => {
        const fs = !!document.fullscreenElement;
        if (SettingsManager.settings.Fullscreen.value !== fs) {
            const item = SettingsManager.settings.Fullscreen;
            item._value = fs; // keep the setting in sync without re-requesting
            item.emit('updated', fs);
        }
    });

    window.addEventListener('beforeunload', () => {
        if (sm.scene instanceof GameScene && GameScene.attempt && !GameScene.attempt.stopped) Stats.RageQuits++;
        saveAll();
    });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) saveAll();
    });
}

let fullscreenTried = false;
// requestFullscreen() consumes the click's user activation, which would stop a file picker or a new tab opened by the
// same click, so those controls (marked data-activation) are skipped and fullscreen waits for the next click
function maybeFullscreen(e) {
    if (fullscreenTried) return;
    if (e?.target?.closest?.('[data-activation]')) return;
    fullscreenTried = true;
    if (SettingsManager.settings.Fullscreen.value && !document.fullscreenElement) {
        document.documentElement.requestFullscreen?.().catch(() => {});
    }
}

// ---------------------------------------------------------------- main loop

let last = performance.now();
let startedAt = performance.now();
let accumulator = 0;

function frame(now) {
    requestAnimationFrame(frame);
    const settings = SettingsManager.settings;
    let delta = (now - last) / 1000;

    // Lock FPS (Engine.MaxFps); browsers can only go as fast as the display refresh rate
    if (settings.LockFPS.value && settings.FPS.value > 0) {
        accumulator += delta;
        if (accumulator < 1 / settings.FPS.value - 0.0005) {
            last = now;
            return;
        }
        delta = accumulator;
        accumulator = 0;
    }
    last = now;
    delta = Math.min(delta, 0.25);
    TIME.value = now / 1000;

    updateTweens(delta);
    const sm = app.sceneManager;
    SoundManager.refreshMenuMusicPlayback(true);
    sm.scene?.update?.(delta);
    if (sm.space && !(sm.scene instanceof GameScene)) sm.space.process(delta);
    app.overlays.update(delta);

    if (sm.scene?.render) sm.scene.render(app.backend);
}

// ---------------------------------------------------------------- boot (Rhythia._Ready)

async function boot() {
    const canvas = document.getElementById('view');
    try {
        app.backend = new RenderBackend(canvas);
    } catch (e) {
        document.body.innerHTML = '<p style="padding:32px">Rhythia needs WebGL 2. Your browser or GPU does not support it.</p>';
        throw e;
    }

    app.sceneManager = new SceneManagerClass();
    app.overlays = new Overlays(app);
    app.menuCursor = app.overlays;

    SettingsManager.load();
    app.backend.setAntiAliasing(SettingsManager.settings.AntiAliasing.value);

    MapManager.initializedPromise = MapManager.initialize();
    // canvas text (Label3D, HUD panels) needs the faces loaded up front
    const faces = ['Nunito Bold', 'Nunito SemiBold', 'Ubuntu Medium', 'Ubuntu Regular', 'Roboto Medium', 'Roboto Bold'];
    const fontLoads = document.fonts ? [...faces.map((f) => document.fonts.load(`32px "${f}"`)), document.fonts.load('600 16px "Open Sans"')] : [];
    await Promise.all([Stats.initialize(), ...fontLoads.map((p) => p.catch(() => {}))]);
    Stats.GamesOpened++;

    await SkinManager.load();
    await SoundManager.updateSkin(SkinManager.skin);
    SoundManager.updateVolume();
    app.overlays.updateCursorSkin(SkinManager.url('cursorImage'), SettingsManager.settings.CursorScale.value);

    app.settingsMenu = new SettingsMenu(app);
    app.onSettingsShown = (shown) => {
        const scene = app.sceneManager.scene;
        if (scene instanceof GameScene && !shown) scene.capture.classList.add('hidden');
    };

    bindInput();
    requestAnimationFrame(frame);

    app.sceneManager.load('loading');

    await MapManager.initializedPromise;
    SoundManager.updateJukeboxQueue();
    if (SettingsManager.settings.AutoplayJukebox.value && MapManager.maps.length) {
        SoundManager.playJukebox(Math.floor(Math.random() * SoundManager.jukeboxQueue.length));
    } else {
        SoundManager.stopScopedSession();
    }

    MapManager.on('mapDeleted', (map) => {
        SoundManager.updateJukeboxQueue();
        const menu = app.sceneManager.scenes.menu;
        if (menu) {
            menu.mapList.updateMaps();
            if (menu.mapList.selectedMapID === map.name) {
                menu.mapList.selectedMapID = null;
                menu.mapInfo.select(null);
                if (MapManager.maps.length > 0) menu.mapList.select(MapManager.maps[0], false);
            }
        }
        if (SoundManager.map?.name === map.name) {
            if (SoundManager.isScopedPlayback() || SoundManager.jukeboxQueue.length === 0) SoundManager.stopScopedSession();
            else SoundManager.playJukebox(Math.floor(Math.random() * SoundManager.jukeboxQueue.length));
        }
    });
    MapManager.on('mapUpdated', () => app.sceneManager.scenes.menu?.mapList.updateMaps());

    setInterval(() => saveAll(), 60000);
}

boot();
