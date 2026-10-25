/**
 * Loaded Skills Indicator — desktop status-bar chip (right cluster).
 *
 * Shows how many skills are READ INTO the active conversation's context right
 * now, and which ones. Clicking the chip opens a dense popover:
 *
 *   • full   — the skill body is still in the transcript: accent dot, bold name
 *   • pruned — the body was compressed away to a [SKILL_PRUNED: …] marker:
 *              ghosted row with a "pruned" tag
 *   • anything never loaded in this conversation is not listed at all
 *
 * Data: this plugin's own backend namespace (`/api/plugins/loaded-skills-indicator/skills`),
 * because the gateway's `session.history` RPC strips tool-result bodies. If
 * that backend is unavailable (plugin not enabled in this profile), the plugin
 * degrades to the display transcript: skill_view invocations are still listed
 * and pruned markers are still read, but a body whose marker the summarizer
 * dropped cannot be told apart — the panel says so explicitly.
 *
 * The chip is a DATA contribution (`variant: 'menu'`), so it gets the app's
 * real status-bar chrome and popover shell. A ⌘K command opens the same list
 * as a full workspace panel (grep/filter, no popover width limit).
 */
import {
  PALETTE_AREA,
  ROUTES_AREA,
  STATUSBAR_AREAS,
  atom,
  host,
  queryClient,
  useQuery,
  useQueryClient,
  useValue
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useEffect, useMemo, useState } from 'react'

const QUERY_KEY = ['loaded-skills']
const PAGE_PATH = '/loaded-skills'
const REFRESH_MS = 5000
const EVENT_THROTTLE_MS = 1200

// ctx.rest / ctx.os.writeClipboard, bound once in register() — the components
// below are module-level.
let rest = null
let writeClipboard = null

/* ---------- data ---------- */

const PRUNE_RE = /\[SKILL_PRUNED:[^\]]*?skill_view\(name='([^']+)'\)/g

function emptyPayload(sid, degraded) {
  return { session_id: sid, count: 0, skills: [], loaded: [], pruned: [], generated_at: Date.now() / 1000, degraded: !!degraded }
}

/** Renderer-only fallback: the display transcript (no tool bodies, markers intact). */
async function fromDisplayTranscript(sid) {
  const res = await host.request('session.history', { session_id: sid })
  const messages = (res && res.messages) || []
  const order = []
  const byName = new Map()
  const note = (name, state, ts) => {
    if (!name) return
    const row = byName.get(name)
    if (!row) {
      order.push(name)
      byName.set(name, { name, state, last_at: ts, origin: state === 'full' ? 'skill_view' : 'compaction' })
      return
    }
    row.state = state
    row.last_at = ts
    row.origin = state === 'full' ? 'skill_view' : 'compaction'
  }
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue
    if (m.role === 'tool' && m.name === 'skill_view' && m.args && m.args.name) {
      note(String(m.args.name), 'full', m.timestamp)
      continue
    }
    const text = typeof m.text === 'string' ? m.text : typeof m.content === 'string' ? m.content : ''
    if (!text || text.indexOf('[SKILL_PRUNED') < 0) continue
    PRUNE_RE.lastIndex = 0
    let hit
    while ((hit = PRUNE_RE.exec(text)) !== null) note(hit[1], 'pruned', m.timestamp)
  }
  const skills = order.map(n => byName.get(n))
  return {
    session_id: sid,
    count: skills.filter(s => s.state === 'full').length,
    skills,
    loaded: skills.filter(s => s.state === 'full').map(s => s.name),
    pruned: skills.filter(s => s.state === 'pruned').map(s => s.name),
    generated_at: Date.now() / 1000,
    degraded: true,
    source: 'display-transcript'
  }
}

async function fetchSkills(sid, storedId) {
  // The REST route reads state.db, which is keyed by the STORED session id; the
  // gateway's session.history RPC only resolves the in-memory RUNTIME id.
  if (!sid && !storedId) return emptyPayload('', false)
  if (rest) {
    try {
      return await rest('/skills?session_id=' + encodeURIComponent(storedId || sid))
    } catch (e) {
      /* backend not enabled / older gateway — degrade, never fail the chip */
    }
  }
  try {
    return await fromDisplayTranscript(sid || storedId)
  } catch (e) {
    return emptyPayload(sid || storedId, true)
  }
}

function useSessionIds() {
  const runtimeId = useValue(host.state.focusedSessionId) || ''
  const storedId = useValue(host.state.focusedStoredSessionId) || ''
  return { runtimeId, storedId }
}

function useSkills() {
  const { runtimeId, storedId } = useSessionIds()
  return useQuery({
    queryKey: [...QUERY_KEY, runtimeId, storedId],
    queryFn: () => fetchSkills(runtimeId, storedId),
    enabled: !!(runtimeId || storedId),
    refetchInterval: REFRESH_MS,
    refetchOnWindowFocus: true,
    staleTime: 1500,
    retry: 1
  })
}

/* ---------- available skills (the "All skills" view) ---------- */

/** Which view the pane shows. Module-level so a ⌘K command can switch an
 *  already-open pane instead of remounting it. */
const $paneView = atom('loaded') // 'loaded' | 'all'

async function fetchAvailable() {
  const rows = []
  const seen = new Set()
  const push = (name, category, description) => {
    const key = String(name || '').trim()
    if (!key || seen.has(key)) return
    seen.add(key)
    rows.push({ name: key, category: category || 'general', description: description || '' })
  }

  // 1. Authoritative: the gateway's own filtered view of what the agent can load.
  let authoritative = false
  try {
    const res = await host.request('skills.manage', { action: 'list' })
    const groups = (res && res.skills) || {}
    for (const category of Object.keys(groups)) {
      for (const name of groups[category] || []) push(name, category, '')
    }
    authoritative = rows.length > 0
  } catch (e) {
    /* older gateway: the disk scan below is the only source */
  }

  // 2. Best-effort descriptions from the skills tree (never required for the list).
  if (rest) {
    try {
      const extra = await rest('/available')
      const byName = new Map()
      for (const s of (extra && extra.skills) || []) byName.set(s.name, s)
      if (authoritative) {
        for (const row of rows) {
          const hit = byName.get(row.name)
          row.description = (hit && hit.description) || ''
        }
      } else {
        for (const s of (extra && extra.skills) || []) push(s.name, s.category, s.description)
      }
    } catch (e) {
      /* no descriptions — names still list */
    }
  }

  rows.sort((a, b) => a.name.localeCompare(b.name))
  return {
    skills: rows,
    count: rows.length,
    enriched: rows.some(r => r.description),
    generated_at: Date.now() / 1000
  }
}

function useAvailableSkills() {
  return useQuery({
    queryKey: [...QUERY_KEY, 'available'],
    queryFn: fetchAvailable,
    staleTime: 60000,
    refetchInterval: 120000,
    retry: 1
  })
}

/** Drop `/<skill>` into the composer — the user reviews and sends it. Never
 *  submits on its own: a click must not spend a turn. */
function insertSkillCommand(name) {
  const command = '/' + name + ' '
  const sid = host.state.focusedSessionId.get() || host.state.focusedStoredSessionId.get() || null
  const copy = () => {
    try {
      if (writeClipboard) writeClipboard(command.trim())
    } catch (e) {
      /* clipboard unavailable */
    }
  }
  const composer = host.composer
  if (!composer || typeof composer.insertText !== 'function') {
    copy()
    return
  }
  Promise.resolve(composer.insertText(sid, command))
    .then(ok => {
      if (!ok) {
        copy()
        return
      }
      try {
        composer.focus(sid)
      } catch (e) {
        /* focus is best-effort */
      }
      try {
        host.notify({ kind: 'info', message: command.trim() + ' added to the composer' })
      } catch (e) {
        /* no toast surface */
      }
    })
    .catch(copy)
}

/* ---------- shared bits ---------- */


const DOT = full => ({
  width: 6,
  height: 6,
  borderRadius: 999,
  flex: '0 0 auto',
  background: full ? 'var(--ui-accent)' : 'transparent',
  border: full ? 'none' : '1px solid var(--ui-text-quaternary)',
  opacity: full ? 1 : 0.8
})

function SkillRow({ skill }) {
  const full = skill.state === 'full'
  return jsxs('div', {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      minHeight: 26,
      padding: '4px 12px'
    },
    children: [
      jsx('span', { key: 'dot', style: DOT(full), title: full ? 'content in context' : 'pruned by compression' }),
      jsx('span', {
        key: 'name',
        style: {
          flex: '1 1 auto',
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontSize: 12,
          fontWeight: full ? 620 : 400,
          color: full ? 'inherit' : 'var(--ui-text-quaternary)'
        },
        children: skill.name
      }),
      full
        ? jsx('span', { key: 'tag', style: { fontSize: 10, color: 'var(--ui-text-quaternary)' }, children: 'in context' })
        : jsx('span', { key: 'tag', style: { fontSize: 10, color: 'var(--ui-text-quaternary)', letterSpacing: '0.02em' }, children: 'pruned' })
    ]
  })
}

function RefreshButton({ onDone }) {
  const qc = useQueryClient()
  const [spinning, setSpinning] = useState(false)
  const click = () => {
    setSpinning(true)
    qc.invalidateQueries({ queryKey: QUERY_KEY })
    setTimeout(() => setSpinning(false), 700)
    if (onDone) onDone()
  }
  return jsx('button', {
    type: 'button',
    onClick: click,
    title: 'Refresh',
    'aria-label': 'Refresh loaded skills',
    style: {
      display: 'inline-flex',
      width: 20,
      height: 20,
      alignItems: 'center',
      justifyContent: 'center',
      border: '1px solid var(--ui-stroke-tertiary)',
      borderRadius: 6,
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer'
    },
    children: jsx('svg', {
      viewBox: '0 0 24 24',
      width: 11,
      height: 11,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      style: spinning ? { animation: 'lsi-spin .7s linear 1' } : undefined,
      children: [
        jsx('path', { key: 'a', d: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' }),
        jsx('path', { key: 'b', d: 'M21 3v5h-5' }),
        jsx('path', { key: 'c', d: 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16' }),
        jsx('path', { key: 'd', d: 'M8 16H3v5' })
      ]
    })
  })
}

/* ---------- status bar chip ---------- */

function ChipDetail() {
  const { data, isError, isLoading } = useSkills()
  if (!data) {
    return jsx('span', { style: { opacity: 0.6 }, children: isLoading ? '…' : isError ? '?' : '0 loaded' })
  }
  const pruned = Array.isArray(data.pruned) ? data.pruned.length : 0
  const kids = [
    jsx('span', { key: 'n', style: { fontVariantNumeric: 'tabular-nums' }, children: String(data.count) }),
    jsx('span', { key: 'l', children: ' loaded' })
  ]
  if (pruned > 0) {
    kids.push(jsx('span', { key: 'p', style: { opacity: 0.7 }, children: ' · ' + pruned + ' pruned' }))
  }
  return jsxs('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 0 }, children: kids })
}

function ChipIcon() {
  return jsx('svg', {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    style: { width: 12, height: 12, display: 'block' },
    children: [
      jsx('path', { key: 'a', d: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20' }),
      jsx('path', { key: 'b', d: 'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z' })
    ]
  })
}

/* ---------- popover ---------- */

function SkillsPanel({ onClose }) {
  const { data, isError, isLoading } = useSkills()
  const skills = data && Array.isArray(data.skills) ? data.skills : []
  const full = skills.filter(s => s.state === 'full')
  const pruned = skills.filter(s => s.state === 'pruned')

  const body = []
  if (isLoading && !data) {
    body.push(jsx('div', { key: 'load', style: { padding: '8px 12px', fontSize: 11, opacity: 0.7 }, children: 'Reading transcript…' }))
  } else if (isError) {
    body.push(jsx('div', { key: 'err', style: { padding: '8px 12px', fontSize: 11, opacity: 0.8 }, children: 'Could not read loaded skills.' }))
  } else if (!skills.length) {
    body.push(
      jsxs('div', { key: 'empty', style: { padding: '10px 12px 12px', fontSize: 11.5, lineHeight: 1.5, opacity: 0.85 }, children: [
        jsx('div', { key: 'h', style: { fontWeight: 600, marginBottom: 2 }, children: 'No skills loaded' }),
        jsx('div', { key: 'b', style: { opacity: 0.8 }, children: 'Nothing has been read into this conversation yet.' })
      ] })
    )
  } else {
    if (full.length) {
      body.push(
        jsx('div', { key: 'fh', style: { padding: '6px 12px 2px', fontSize: 10, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ui-text-quaternary)' }, children: 'In context · ' + full.length })
      )
      full.forEach(s => body.push(jsx(SkillRow, { skill: s }, 'f-' + s.name)))
    }
    if (pruned.length) {
      body.push(
        jsx('div', { key: 'ph', style: { padding: '8px 12px 2px', fontSize: 10, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ui-text-quaternary)' }, children: 'Pruned · ' + pruned.length })
      )
      pruned.forEach(s => body.push(jsx(SkillRow, { skill: s }, 'p-' + s.name)))
    }
  }

  const footerNote = data && data.degraded
    ? 'Backend off — display transcript only'
    : data
      ? 'from this conversation’s transcript'
      : ''

  return jsxs('div', {
    style: { display: 'flex', width: 340, flexDirection: 'column', fontSize: 12 },
    children: [
      jsx('style', { key: 'kf', children: '@keyframes lsi-spin{to{transform:rotate(360deg)}}' }),
      jsxs('div', {
        key: 'head',
        style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '10px 12px 6px' },
        children: [
          jsx('span', { key: 't', style: { fontSize: 12, fontWeight: 650 }, children: 'Loaded skills' }),
          jsxs('span', { key: 'r', style: { display: 'inline-flex', alignItems: 'center', gap: 7 }, children: [
            jsx('span', { key: 'c', style: { fontSize: 11, opacity: 0.75, fontVariantNumeric: 'tabular-nums' }, children: (data ? data.count : 0) + ' in context' }),
            jsx(RefreshButton, { key: 'b' })
          ] })
        ]
      }),
      jsx('div', {
        key: 'body',
        style: { maxHeight: 320, overflowY: 'auto', paddingBottom: 4 },
        children: body
      }),
      jsxs('div', {
        key: 'foot',
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          borderTop: '1px solid var(--ui-stroke-tertiary)',
          padding: '7px 12px',
          fontSize: 10.5,
          color: 'var(--ui-text-quaternary)'
        },
        children: [
          jsx('span', { key: 'n', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: footerNote }),
          jsx('button', {
            key: 'open',
            type: 'button',
            onClick: () => {
              if (onClose) onClose()
              openSkillsPane('loaded')
            },
            style: {
              border: 'none',
              background: 'transparent',
              color: 'var(--ui-accent)',
              cursor: 'pointer',
              fontSize: 10.5,
              padding: 0,
              flex: '0 0 auto'
            },
            children: 'Open panel →'
          })
        ]
      })
    ]
  })
}

/* ---------- dockable pane ---------- */

/** Open the pane beside the conversation (optionally on a given view).
 *  `openWorkspace` re-fronts the same id instead of stacking duplicates, so
 *  repeated ⌘K presses are harmless; older desktops without it get the
 *  full-page route instead. */
function openSkillsPane(view) {
  if (view === 'all' || view === 'loaded') $paneView.set(view)
  if (!host || typeof host.openWorkspace !== 'function') {
    host.navigate(PAGE_PATH)
    return
  }
  host.openWorkspace('loaded-skills', {
    title: 'Skills',
    dock: { pane: 'workspace', pos: 'right' },
    minWidth: '20rem',
    render: () => jsx(SkillsPane, {})
  })
}

const VIEWS = [
  { id: 'loaded', label: 'loaded', hint: 'Skills read into this conversation' },
  { id: 'all', label: 'available', hint: 'Every skill you can load' }
]

const SWITCH_BRACKET = { color: 'var(--ui-text-quaternary)', fontSize: 11, opacity: 0.65 }

/** `( loaded | available )` — two clickable words in brackets, so the switch
 *  reads as a toggle instead of two stray labels. */
function ViewSwitch({ view }) {
  const kids = [jsx('span', { key: 'open', style: SWITCH_BRACKET, children: '(' })]
  VIEWS.forEach((v, i) => {
    if (i > 0) kids.push(jsx('span', { key: 'sep-' + v.id, style: SWITCH_BRACKET, children: '|' }))
    const active = v.id === view
    kids.push(
      jsx('button', {
        key: v.id,
        type: 'button',
        onClick: () => $paneView.set(v.id),
        'aria-pressed': active,
        title: v.hint,
        style: {
          border: 'none',
          background: 'transparent',
          borderRadius: 3,
          cursor: 'pointer',
          fontSize: 11,
          lineHeight: 1.4,
          padding: '0 2px',
          color: active ? 'var(--ui-accent)' : 'var(--ui-text-quaternary)',
          fontWeight: active ? 650 : 400,
          textDecoration: active ? 'underline' : 'none',
          textUnderlineOffset: 2
        },
        children: v.label
      })
    )
  })
  kids.push(jsx('span', { key: 'close', style: SWITCH_BRACKET, children: ')' }))
  return jsx('div', { style: { display: 'inline-flex', alignItems: 'center', gap: 3 }, children: kids })
}

/** One row in "All skills": name, description, and whether it is already in
 *  context. Clicking drops `/name` into the composer — never submits it. */
function AvailableRow({ skill, state }) {
  const full = state === 'full'
  const pruned = state === 'pruned'
  return jsxs('button', {
    type: 'button',
    onClick: () => insertSkillCommand(skill.name),
    title: skill.description ? skill.description + '\n\nClick to put /' + skill.name + ' in the composer' : 'Click to put /' + skill.name + ' in the composer',
    style: {
      display: 'flex',
      alignItems: 'baseline',
      gap: 8,
      width: '100%',
      textAlign: 'left',
      border: 'none',
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer',
      padding: '4px 12px',
      minHeight: 24
    },
    children: [
      jsx('span', {
        key: 'dot',
        style: {
          width: 5,
          height: 5,
          borderRadius: 999,
          flex: '0 0 auto',
          alignSelf: 'center',
          background: full ? 'var(--ui-accent)' : 'transparent',
          border: full ? 'none' : pruned ? '1px solid var(--ui-text-quaternary)' : '1px solid var(--ui-stroke-secondary)',
          opacity: pruned ? 0.8 : 1
        }
      }),
      jsxs('span', { key: 'body', style: { minWidth: 0, flex: '1 1 auto', display: 'flex', flexDirection: 'column' }, children: [
        jsx('span', {
          key: 'n',
          style: {
            fontSize: 12,
            fontWeight: full ? 620 : 400,
            color: pruned ? 'var(--ui-text-quaternary)' : 'inherit',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          },
          children: skill.name
        }),
        skill.description
          ? jsx('span', {
              key: 'd',
              style: {
                fontSize: 10.5,
                lineHeight: 1.35,
                color: 'var(--ui-text-quaternary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              },
              children: skill.description
            })
          : null
      ] }),
      jsx('span', {
        key: 'tag',
        style: { flex: '0 0 auto', fontSize: 10, color: 'var(--ui-text-quaternary)', alignSelf: 'center' },
        children: full ? 'in context' : pruned ? 'pruned' : '+'
      })
    ].filter(Boolean)
  })
}

/** The pane body: "Loaded" is the original transcript view; "All skills" is the
 *  inventory you can load from. Same docked column, one switch. */
function SkillsPane() {
  const view = useValue($paneView)
  const loadedQuery = useSkills()
  const availableQuery = useAvailableSkills()
  const [filter, setFilter] = useState('')

  const loaded = loadedQuery.data && Array.isArray(loadedQuery.data.skills) ? loadedQuery.data.skills : []
  const loadedState = useMemo(() => {
    const map = {}
    for (const s of loaded) map[s.name] = s.state
    return map
  }, [loaded])
  const full = loaded.filter(s => s.state === 'full').length
  const pruned = loaded.filter(s => s.state === 'pruned').length

  const available = availableQuery.data && Array.isArray(availableQuery.data.skills) ? availableQuery.data.skills : []
  const q = filter.trim().toLowerCase()
  const matches = list =>
    q
      ? list.filter(s => s.name.toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q))
      : list

  const shownLoaded = matches(loaded)
  const shownAvailable = matches(available)
  const groups = useMemo(() => {
    const out = []
    const index = new Map()
    for (const s of shownAvailable) {
      const cat = s.category || 'general'
      if (!index.has(cat)) {
        index.set(cat, out.length)
        out.push({ category: cat, items: [] })
      }
      out[index.get(cat)].items.push(s)
    }
    return out
  }, [shownAvailable])

  const isLoading = view === 'loaded' ? loadedQuery.isLoading && !loadedQuery.data : availableQuery.isLoading && !availableQuery.data
  const isError = view === 'loaded' ? loadedQuery.isError : availableQuery.isError

  const body = []
  if (isLoading) {
    body.push(jsx('div', { key: 'load', style: { padding: '8px 12px', fontSize: 11.5, opacity: 0.7 }, children: view === 'loaded' ? 'Reading transcript…' : 'Reading skills…' }))
  } else if (isError) {
    body.push(jsx('div', { key: 'err', style: { padding: '8px 12px', fontSize: 11.5 }, children: view === 'loaded' ? 'Could not read loaded skills.' : 'Could not read the skills list.' }))
  } else if (view === 'loaded') {
    if (!shownLoaded.length) {
      body.push(jsx('div', { key: 'empty', style: { padding: '8px 12px', fontSize: 11.5, color: 'var(--ui-text-quaternary)' }, children: loaded.length ? 'No skill matches that filter.' : 'No skills have been read into this conversation.' }))
    } else {
      for (const s of shownLoaded) body.push(jsx(SkillRow, { skill: s }, 'l-' + s.name))
    }
  } else if (!shownAvailable.length) {
    body.push(jsx('div', { key: 'empty', style: { padding: '8px 12px', fontSize: 11.5, color: 'var(--ui-text-quaternary)' }, children: available.length ? 'No skill matches that filter.' : 'No skills found on disk.' }))
  } else {
    for (const group of groups) {
      body.push(
        jsx('div', {
          key: 'h-' + group.category,
          style: { padding: '7px 12px 2px', fontSize: 10, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ui-text-quaternary)' },
          children: group.category
        })
      )
      for (const s of group.items) body.push(jsx(AvailableRow, { skill: s, state: loadedState[s.name] || '' }, 'a-' + s.name))
    }
  }

  const headCount =
    view === 'loaded'
      ? full + ' in context · ' + pruned + ' pruned'
      : available.length + ' available · ' + full + ' loaded'

  const footNote =
    view === 'loaded'
      ? loadedQuery.data && loadedQuery.data.degraded
        ? 'Backend off — display transcript'
        : 'live from the transcript'
      : 'click a skill to put /name in the composer'

  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, gap: 8, padding: '10px 12px' },
    children: [
      jsxs('div', { key: 'head', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }, children: [
        jsx(ViewSwitch, { key: 's', view }),
        jsx(RefreshButton, { key: 'r' })
      ] }),
      jsx('div', { key: 'count', style: { fontSize: 10.5, color: 'var(--ui-text-quaternary)', fontVariantNumeric: 'tabular-nums' }, children: headCount }),
      jsx('input', {
        key: 'filter',
        value: filter,
        onChange: e => setFilter(e.target.value),
        placeholder: view === 'loaded' ? 'Filter loaded skills…' : 'Filter available skills…',
        style: {
          width: '100%',
          boxSizing: 'border-box',
          height: 26,
          padding: '0 8px',
          fontSize: 11.5,
          color: 'inherit',
          background: 'transparent',
          border: '1px solid var(--ui-stroke-secondary)',
          borderRadius: 7,
          outline: 'none',
          flex: '0 0 auto'
        }
      }),
      jsx('div', {
        key: 'list',
        style: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', border: '1px solid var(--ui-stroke-secondary)', borderRadius: 8, padding: '4px 0' },
        children: body
      }),
      jsxs('div', { key: 'foot', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 10.5, color: 'var(--ui-text-quaternary)' }, children: [
        jsx('span', { key: 'n', style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: footNote }),
        jsx('button', {
          key: 'page',
          type: 'button',
          onClick: () => host.navigate(PAGE_PATH),
          style: { border: 'none', background: 'transparent', color: 'var(--ui-accent)', cursor: 'pointer', fontSize: 10.5, padding: 0, flex: '0 0 auto' },
          children: 'Full page →'
        })
      ] })
    ]
  })
}


/* ---------- full page (deep link / roomy view) ---------- */


function SkillsPage() {
  const { data, isError, isLoading } = useSkills()
  const [filter, setFilter] = useState('')
  const skills = data && Array.isArray(data.skills) ? data.skills : []
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return q ? skills.filter(s => s.name.toLowerCase().includes(q)) : skills
  }, [skills, filter])

  const full = skills.filter(s => s.state === 'full').length
  const pruned = skills.filter(s => s.state === 'pruned').length

  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, padding: '18px 22px', gap: 12 },
    children: [
      jsxs('div', { key: 'head', style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }, children: [
        jsx('div', { key: 't', style: { fontSize: 16, fontWeight: 650 }, children: 'Loaded skills' }),
        jsx('div', { key: 's', style: { fontSize: 11.5, color: 'var(--ui-text-quaternary)' }, children: full + ' in context · ' + pruned + ' pruned · ' + (data ? REFRESH_MS / 1000 : '–') + 's refresh' })
      ] }),
      jsxs('div', { key: 'bar', style: { display: 'flex', alignItems: 'center', gap: 8 }, children: [
        jsx('input', {
          key: 'f',
          value: filter,
          onChange: e => setFilter(e.target.value),
          placeholder: 'Filter skills…',
          style: {
            flex: '0 1 260px',
            height: 28,
            padding: '0 9px',
            fontSize: 12,
            color: 'inherit',
            background: 'transparent',
            border: '1px solid var(--ui-stroke-secondary)',
            borderRadius: 7,
            outline: 'none'
          }
        }),
        jsx(RefreshButton, { key: 'r' }),
        jsx('span', { key: 'n', style: { fontSize: 11, color: 'var(--ui-text-quaternary)' }, children: shown.length + ' shown' })
      ] }),
      jsxs('div', {
        key: 'list',
        style: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', border: '1px solid var(--ui-stroke-secondary)', borderRadius: 9, padding: '6px 0' },
        children: [
          isLoading && !data
            ? jsx('div', { style: { padding: '10px 12px', fontSize: 12, opacity: 0.7 }, children: 'Reading transcript…' }, 'load')
            : isError
              ? jsx('div', { style: { padding: '10px 12px', fontSize: 12 }, children: 'Could not read loaded skills.' }, 'err')
              : shown.length
                ? shown.map(s => jsx(SkillRow, { skill: s }, s.name))
                : jsx('div', { style: { padding: '10px 12px', fontSize: 12, color: 'var(--ui-text-quaternary)' }, children: skills.length ? 'No skill matches that filter.' : 'No skills have been read into this conversation.' }, 'empty')
        ]
      }),
      jsx('div', {
        key: 'foot',
        style: { fontSize: 10.5, color: 'var(--ui-text-quaternary)' },
        children: data && data.degraded
          ? 'Backend unavailable for this profile — showing the display transcript, which cannot see pruned tool bodies.'
          : 'A skill counts as loaded while its body is still in the transcript; compression replaces it with a pruned marker and it is ghosted here.'
      })
    ]
  })
}

/* ---------- live refresh ---------- */

let pendingTimer = null

function scheduleRefresh() {
  if (pendingTimer) return
  pendingTimer = setTimeout(() => {
    pendingTimer = null
    try {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY })
    } catch (e) {
      /* query client unavailable — the 5s interval still runs */
    }
  }, EVENT_THROTTLE_MS)
}

function onGatewayEvent(event) {
  if (!event || typeof event.type !== 'string') return
  if (!/tool|message|session\.|context|skill|compact|turn|usage/i.test(event.type)) return
  scheduleRefresh()
}

/* ---------- registration ---------- */

export default {
  id: 'loaded-skills-indicator',
  name: 'Loaded Skills Indicator',
  description: 'Status-bar chip showing which skills are loaded into the active conversation, with a popover listing them.',
  register(ctx) {
    try {
      rest = ctx.rest || null
    } catch (e) {
      rest = null
    }
    try {
      writeClipboard = ctx.os && typeof ctx.os.writeClipboard === 'function' ? ctx.os.writeClipboard.bind(ctx.os) : null
    } catch (e) {
      writeClipboard = null
    }
    try {
      ctx.onEvent('*', onGatewayEvent)
    } catch (e) {
      /* older host: interval refresh only */
    }

    ctx.registerMany([
      {
        id: 'chip',
        area: STATUSBAR_AREAS.right,
        order: 45,
        data: {
          id: 'loaded-skills',
          icon: jsx(ChipIcon, {}),
          label: 'Skills:',
          detail: jsx(ChipDetail, {}),
          variant: 'menu',
          menuAlign: 'end',
          menuClassName: 'w-auto border-(--ui-stroke-secondary) p-0',
          menuContent: close => jsx(SkillsPanel, { onClose: close }),
          title: 'Skills loaded into this conversation’s context',
          toggleLabel: 'Loaded skills'
        }
      },
      {
        id: 'page',
        area: ROUTES_AREA,
        data: { path: PAGE_PATH },
        render: () => jsx(SkillsPage, {})
      },
      {
        id: 'open',
        area: PALETTE_AREA,
        data: {
          id: 'loaded-skills.open',
          label: 'Skills: open pane',
          keywords: ['skills', 'loaded', 'context', 'pruned', 'compression', 'pane'],
          run: () => openSkillsPane('loaded')
        }
      },
      {
        id: 'open-all',
        area: PALETTE_AREA,
        data: {
          id: 'loaded-skills.openAll',
          label: 'Skills: open all skills',
          keywords: ['skills', 'all', 'available', 'library', 'load', 'pane'],
          run: () => openSkillsPane('all')
        }
      }
    ])
  }
}
