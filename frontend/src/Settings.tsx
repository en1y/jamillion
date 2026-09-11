// The cabin: the settings panel behind the gear, and the tier mark it skins.
import { emojiForTier, MISS_EMOJI, tierSlug } from './flight'
import { setPrefs, sfx, usePrefs } from './prefs'
import type { Tier } from './api'

/** A tier's mark: the glyph, or the rendered badge, whichever the player picked.
 *  The share text stays emoji either way -- a clipboard has no images. */
export function TierIcon({ tier, tiers, correct = true }: { tier: string | null; tiers: Tier[]; correct?: boolean }) {
  const { tiers: skin } = usePrefs()
  const glyph = correct ? emojiForTier(tier, tiers) : MISS_EMOJI
  if (skin === 'emoji' || !correct || !tier) return <>{glyph}</>
  return <img className="tier-art" src={`/tiers/${tierSlug(tier)}.png`} alt={tier} title={tier} />
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <p className="set-row"><span>{label}</span><span className="set-ctl">{children}</span></p>
}

function Pick<T extends string>({ value, options, onPick }: {
  value: T; options: [T, string][]; onPick: (next: T) => void
}) {
  return (<>
    {options.map(([key, label]) => (
      <button key={key} type="button" className="chip" aria-pressed={value === key}
              onClick={() => { onPick(key); sfx('click') }}>{label}</button>
    ))}
  </>)
}

/** The gear in the header. A dialog, not a route: settings are changed mid-flight
 *  and the flight must still be there underneath. */
export function Settings({ open, onClose }: { open: boolean; onClose: () => void }) {
  const prefs = usePrefs()
  if (!open) return null
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Settings"
         onClick={event => { if (event.target === event.currentTarget) onClose() }}>
      <section className="panel settings">
        <p className="eyebrow">CABIN SETTINGS</p>
        <Row label="Sound effects">
          <button type="button" className="chip" aria-pressed={prefs.sfx}
                  onClick={() => { setPrefs({ sfx: !prefs.sfx }); if (!prefs.sfx) sfx('brief') }}>
            {prefs.sfx ? '🔊 on' : '🔇 muted'}
          </button>
        </Row>
        <Row label="Effects level">
          <input type="range" min={0} max={1} step={0.05} value={prefs.sfxVolume} disabled={!prefs.sfx}
                 aria-label="Sound effects volume"
                 onChange={event => setPrefs({ sfxVolume: Number(event.target.value) })}
                 onMouseUp={() => sfx('brief')} onTouchEnd={() => sfx('brief')} />
          <b>{Math.round(prefs.sfxVolume * 100)}%</b>
        </Row>
        <Row label="Music level">
          <input type="range" min={0} max={1} step={0.05} value={prefs.music} aria-label="Snippet volume"
                 onChange={event => setPrefs({ music: Number(event.target.value) })} />
          <b>{Math.round(prefs.music * 100)}%</b>
        </Row>
        <Row label="Tier marks">
          <Pick value={prefs.tiers} onPick={tiers => setPrefs({ tiers })}
                options={[['art', 'badges'], ['emoji', 'glyphs']]} />
        </Row>
        <Row label="Planets">
          <Pick value={prefs.planets} onPick={planets => setPrefs({ planets })}
                options={[['render', 'rendered'], ['disc', 'discs'], ['ticks', 'charts']]} />
        </Row>
        <p className="meta">The tier badges also ride the flight log and the haul. Shared results stay glyphs.</p>
        <button className="cta" type="button" onClick={() => { sfx('click'); onClose() }}>◀ back to the deck</button>
      </section>
    </div>
  )
}
