import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useStore } from '../store'

/**
 * Typing, for when talking out loud isn't an option.
 *
 * Enter opens it, Enter sends, Escape puts it away. A typed line is an ordinary
 * turn: it needs no wake word, cuts him off mid-answer the way speaking would,
 * and the reply is still spoken and still lands in the transcript. It stays
 * open after sending, so a follow-up is one more line rather than another
 * Enter.
 */
export function TypeBar({ onSend }: { onSend: (text: string) => void }) {
  const phase = useStore((s) => s.phase)
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')

  const live = phase !== 'offline' && phase !== 'boot'
  // Read by the window listener, so it is bound once rather than per phase.
  const liveRef = useRef(live)
  liveRef.current = live

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!liveRef.current) return
      if (e.key !== 'Enter' || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return
      // Enter already means something to a focused field, button or link.
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'A') return
      // Also cancels the keypress, so the Enter that opens the bar cannot
      // arrive in the freshly focused field and submit it.
      e.preventDefault()
      setOpen(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const close = () => {
    setOpen(false)
    setText('')
  }

  const send = () => {
    const said = text.trim()
    if (!said) return
    onSend(said)
    setText('')
  }

  return (
    <AnimatePresence>
      {open && live && (
        <motion.form
          className="typebar"
          // Framer owns `transform` on an animated element, so the centring
          // lives here rather than in the stylesheet — same as .tool-badge.
          initial={{ opacity: 0, x: '-50%', y: 8 }}
          animate={{ opacity: 1, x: '-50%', y: 0 }}
          exit={{ opacity: 0, x: '-50%', y: 8 }}
          transition={{ type: 'spring', stiffness: 320, damping: 30 }}
          onSubmit={(e) => {
            e.preventDefault()
            send()
          }}
        >
          <span className="typebar-who">YOU</span>
          <input
            autoFocus
            className="typebar-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // Sent here rather than left to the form's implicit submission,
              // which only fires for a trusted key press. The composing check
              // keeps an IME's confirming Enter from sending half a word.
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault()
                send()
                return
              }
              // The global Escape (stand down) ignores inputs, so this one only
              // puts the bar away and leaves JARVIS as he was.
              if (e.key === 'Escape') {
                e.preventDefault()
                close()
              }
            }}
            // Clicking away from an empty bar puts it away; a half-written
            // line is kept until it is sent or escaped.
            onBlur={() => {
              if (!text.trim()) close()
            }}
            placeholder="Type to JARVIS…"
            aria-label="Type a message to JARVIS"
            autoComplete="off"
            maxLength={2000}
          />
          <kbd className="typebar-send">↵</kbd>
        </motion.form>
      )}
    </AnimatePresence>
  )
}
