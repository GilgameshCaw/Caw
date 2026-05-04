import React, { useState, useMemo, useEffect } from 'react'
import { HiX, HiCheck } from 'react-icons/hi'
import { extractMuteableWords } from '~/hooks/useMutePreferences'
import ModalWrapper from './ModalWrapper'
import ModalHeader from './ModalHeader'
import { useT } from '~/i18n/I18nProvider'

interface MuteWordsModalProps {
  isOpen: boolean
  onClose: () => void
  onMute: (words: string[]) => void
  postContent: string
  existingMutedWords?: string[]
}

const MuteWordsModal: React.FC<MuteWordsModalProps> = ({
  isOpen,
  onClose,
  onMute,
  postContent,
  existingMutedWords = []
}) => {
  const t = useT()
  const [customWord, setCustomWord] = useState('')

  const [selectedWords, setSelectedWords] = useState<Set<string>>(new Set())

  // Extract words from post content
  const availableWords = useMemo(() => {
    const extracted = extractMuteableWords(postContent)
    // Filter out already muted words
    return extracted.filter(w => !existingMutedWords.includes(w.toLowerCase()))
  }, [postContent, existingMutedWords])

  // Pre-select first two words when modal opens
  useEffect(() => {
    if (isOpen) {
      const initial = new Set<string>()
      availableWords.slice(0, 2).forEach(w => initial.add(w))
      setSelectedWords(initial)
      setCustomWord('')
    }
  }, [isOpen, availableWords])

  const toggleWord = (word: string) => {
    setSelectedWords(prev => {
      const newSet = new Set(prev)
      if (newSet.has(word)) {
        newSet.delete(word)
      } else {
        newSet.add(word)
      }
      return newSet
    })
  }

  const handleAddCustom = () => {
    const trimmed = customWord.trim().toLowerCase()
    if (trimmed && !selectedWords.has(trimmed) && !existingMutedWords.includes(trimmed)) {
      setSelectedWords(prev => new Set([...prev, trimmed]))
      setCustomWord('')
    }
  }

  const handleMute = () => {
    if (selectedWords.size > 0) {
      onMute(Array.from(selectedWords))
      setSelectedWords(new Set())
      onClose()
    }
  }

  // Separate hashtags/cashtags from regular words
  const tags = availableWords.filter(w => w.startsWith('#') || w.startsWith('$'))
  const words = availableWords.filter(w => !w.startsWith('#') && !w.startsWith('$'))

  return (
    <ModalWrapper
      isOpen={isOpen}
      onClose={onClose}
      maxWidth="max-w-md"
      zIndex={60}
      usePortal
      backdropClass="bg-black/60"
      className="shadow-2xl"
    >
      <ModalHeader
        title={t('mute_words.title')}
        onClose={onClose}
        borderClass="border-b border-yellow-500/20"
        forceDark
      />

      {/* Content */}
      <div className="p-4 max-h-[60vh] overflow-y-auto">
        {/* Tags Section */}
        {tags.length > 0 && (
          <div className="mb-4">
            <h4 className="text-sm font-medium mb-2 text-white/70">
              {t('mute_words.section.tags')}
            </h4>
            <div className="flex flex-wrap gap-2">
              {tags.map(tag => (
                <button
                  key={tag}
                  onClick={() => toggleWord(tag)}
                  className={`px-3 py-1.5 rounded-full text-sm transition-all ${
                    selectedWords.has(tag)
                      ? 'bg-yellow-500 text-black'
                      : 'bg-white/10 text-white hover:bg-white/20'
                  }`}
                >
                  {selectedWords.has(tag) && <HiCheck className="inline w-3 h-3 mr-1" />}
                  {tag}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Words Section */}
        {words.length > 0 && (
          <div className="mb-4">
            <h4 className="text-sm font-medium mb-2 text-white/70">
              {t('mute_words.section.words')}
            </h4>
            <div className="flex flex-wrap gap-2">
              {words.slice(0, 20).map(word => (
                <button
                  key={word}
                  onClick={() => toggleWord(word)}
                  className={`px-3 py-1.5 rounded-full text-sm transition-all ${
                    selectedWords.has(word)
                      ? 'bg-yellow-500 text-black'
                      : 'bg-white/10 text-white hover:bg-white/20'
                  }`}
                >
                  {selectedWords.has(word) && <HiCheck className="inline w-3 h-3 mr-1" />}
                  {word}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* No words extracted */}
        {tags.length === 0 && words.length === 0 && (
          <p className="text-sm mb-4 text-white/50">
            {t('mute_words.empty')}
          </p>
        )}

        {/* Custom Word Input */}
        <div className="mt-4">
          <h4 className="text-sm font-medium mb-2 text-white/70">
            {t('mute_words.section.custom')}
          </h4>
          <div className="flex gap-2">
            <input
              type="text"
              value={customWord}
              onChange={(e) => setCustomWord(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAddCustom()}
              placeholder={t('mute_words.placeholder')}
              className="flex-1 px-3 py-2 rounded-lg border text-sm bg-white/5 border-white/20 text-white placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-yellow-500 focus:border-yellow-500"
            />
            <button
              onClick={handleAddCustom}
              disabled={!customWord.trim()}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                customWord.trim()
                  ? 'bg-yellow-500 text-black hover:bg-yellow-400'
                  : 'bg-white/10 text-white/30 cursor-not-allowed'
              }`}
            >
              {t('mute_words.add')}
            </button>
          </div>
        </div>

        {/* Selected Words Preview */}
        {selectedWords.size > 0 && (
          <div className="mt-4 pt-4 border-t border-yellow-500/20">
            <h4 className="text-sm font-medium mb-2 text-white/70">
              {t('mute_words.selected', { count: selectedWords.size })}
            </h4>
            <div className="flex flex-wrap gap-2">
              {Array.from(selectedWords).map(word => (
                <span
                  key={word}
                  className="px-2 py-1 rounded bg-yellow-500/20 text-yellow-500 text-sm flex items-center gap-1"
                >
                  {word}
                  <button
                    onClick={() => toggleWord(word)}
                    className="hover:text-yellow-300"
                  >
                    <HiX className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex justify-end gap-3 px-4 py-3 border-t border-yellow-500/20">
        <button
          onClick={onClose}
          className="px-4 py-2 rounded-lg text-sm font-medium transition-colors text-white/70 hover:bg-white/10"
        >
          {t('common.cancel')}
        </button>
        <button
          onClick={handleMute}
          disabled={selectedWords.size === 0}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            selectedWords.size > 0
              ? 'bg-yellow-500 text-black hover:bg-yellow-400'
              : 'bg-white/10 text-white/30 cursor-not-allowed'
          }`}
        >
          {t('mute_words.mute_button')} {selectedWords.size > 0 ? `(${selectedWords.size})` : ''}
        </button>
      </div>
    </ModalWrapper>
  )
}

export default MuteWordsModal
