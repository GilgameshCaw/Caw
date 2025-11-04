import React, { useState, useRef } from 'react'
import { HiOutlinePhotograph, HiOutlinePaperClip, HiOutlineX } from 'react-icons/hi'
import { useTheme } from '~/hooks/useTheme'

interface FilePreview {
  id: string
  file: File
  preview?: string
  type: 'image' | 'file'
}

interface MessageFileUploadProps {
  onFilesSelected: (files: File[]) => void
  onCancel: () => void
  maxSize?: number // in MB
}

const MessageFileUpload: React.FC<MessageFileUploadProps> = ({
  onFilesSelected,
  onCancel,
  maxSize = 10
}) => {
  const { isDark } = useTheme()
  const [selectedFiles, setSelectedFiles] = useState<FilePreview[]>([])
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)

  const handleFileSelect = (files: FileList | null, type: 'image' | 'file') => {
    if (!files || files.length === 0) return

    setError(null)
    const newFiles: FilePreview[] = []

    for (let i = 0; i < files.length; i++) {
      const file = files[i]

      // Check file size
      if (file.size > maxSize * 1024 * 1024) {
        setError(`File "${file.name}" exceeds ${maxSize}MB limit`)
        continue
      }

      const filePreview: FilePreview = {
        id: `${Date.now()}-${i}`,
        file,
        type: file.type.startsWith('image/') ? 'image' : 'file'
      }

      // Create preview for images
      if (file.type.startsWith('image/')) {
        const reader = new FileReader()
        reader.onload = (e) => {
          setSelectedFiles(prev => prev.map(f =>
            f.id === filePreview.id
              ? { ...f, preview: e.target?.result as string }
              : f
          ))
        }
        reader.readAsDataURL(file)
      }

      newFiles.push(filePreview)
    }

    setSelectedFiles(prev => [...prev, ...newFiles])
  }

  const removeFile = (id: string) => {
    setSelectedFiles(prev => prev.filter(f => f.id !== id))
  }

  const handleSend = () => {
    if (selectedFiles.length === 0) return
    onFilesSelected(selectedFiles.map(f => f.file))
    setSelectedFiles([])
  }

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  }

  return (
    <div className={`p-4 border-t ${
      isDark ? 'border-gray-700' : 'border-gray-200'
    }`}>
      {/* File selection buttons */}
      <div className="flex space-x-4 mb-4">
        <button
          onClick={() => imageInputRef.current?.click()}
          className={`flex items-center space-x-2 px-4 py-2 rounded-lg transition-all duration-300 ${
            isDark
              ? 'bg-gray-800 hover:bg-gray-700 text-white'
              : 'bg-gray-100 hover:bg-gray-200 text-black'
          }`}
        >
          <HiOutlinePhotograph className="w-5 h-5" />
          <span className="text-sm font-medium">Add Images</span>
        </button>

        <button
          onClick={() => fileInputRef.current?.click()}
          className={`flex items-center space-x-2 px-4 py-2 rounded-lg transition-all duration-300 ${
            isDark
              ? 'bg-gray-800 hover:bg-gray-700 text-white'
              : 'bg-gray-100 hover:bg-gray-200 text-black'
          }`}
        >
          <HiOutlinePaperClip className="w-5 h-5" />
          <span className="text-sm font-medium">Add Files</span>
        </button>
      </div>

      {/* Hidden file inputs */}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => handleFileSelect(e.target.files, 'image')}
      />

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => handleFileSelect(e.target.files, 'file')}
      />

      {/* Error message */}
      {error && (
        <div className={`mb-4 p-3 rounded-lg ${
          isDark ? 'bg-red-900/20 text-red-400' : 'bg-red-50 text-red-600'
        }`}>
          <p className="text-sm">{error}</p>
        </div>
      )}

      {/* Selected files preview */}
      {selectedFiles.length > 0 && (
        <div className="space-y-2 mb-4 max-h-60 overflow-y-auto">
          {selectedFiles.map((filePreview) => (
            <div
              key={filePreview.id}
              className={`flex items-center justify-between p-3 rounded-lg ${
                isDark ? 'bg-gray-800' : 'bg-gray-100'
              }`}
            >
              <div className="flex items-center space-x-3">
                {filePreview.type === 'image' && filePreview.preview ? (
                  <img
                    src={filePreview.preview}
                    alt={filePreview.file.name}
                    className="w-12 h-12 object-cover rounded"
                  />
                ) : (
                  <div className={`w-12 h-12 rounded flex items-center justify-center ${
                    isDark ? 'bg-gray-700' : 'bg-gray-200'
                  }`}>
                    <HiOutlinePaperClip className="w-6 h-6" />
                  </div>
                )}
                <div>
                  <p className={`text-sm font-medium truncate max-w-xs ${
                    isDark ? 'text-white' : 'text-black'
                  }`}>
                    {filePreview.file.name}
                  </p>
                  <p className={`text-xs ${
                    isDark ? 'text-gray-400' : 'text-gray-600'
                  }`}>
                    {formatFileSize(filePreview.file.size)}
                  </p>
                </div>
              </div>

              <button
                onClick={() => removeFile(filePreview.id)}
                className={`p-1 rounded-full transition-all duration-300 hover:bg-gray-500/20 ${
                  isDark ? 'text-gray-400' : 'text-gray-600'
                }`}
              >
                <HiOutlineX className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Action buttons */}
      {selectedFiles.length > 0 && (
        <div className="flex justify-end space-x-3">
          <button
            onClick={onCancel}
            className={`px-4 py-2 rounded-lg font-medium transition-all duration-300 ${
              isDark
                ? 'bg-gray-800 hover:bg-gray-700 text-white'
                : 'bg-gray-200 hover:bg-gray-300 text-black'
            }`}
          >
            Cancel
          </button>
          <button
            onClick={handleSend}
            className="px-4 py-2 rounded-lg font-medium bg-yellow-500 hover:bg-yellow-600 text-black transition-all duration-300"
          >
            Send {selectedFiles.length} {selectedFiles.length === 1 ? 'File' : 'Files'}
          </button>
        </div>
      )}
    </div>
  )
}

export default MessageFileUpload