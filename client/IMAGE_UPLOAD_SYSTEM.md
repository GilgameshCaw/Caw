# CAW Protocol Image Upload System

## Overview

The CAW Protocol now supports comprehensive image upload functionality with both on-chain and off-chain storage options. Users can upload images with their posts and choose between decentralized permanent storage on the blockchain or traditional cloud storage.

## Features

### 🖼️ Image Upload Components
- **Drag & Drop Interface**: Intuitive drag-and-drop upload area
- **File Validation**: Supports PNG, JPG, GIF, WebP formats up to 10MB
- **Image Preview**: Real-time preview with dimensions and size information
- **Mobile Support**: Full mobile responsive design with touch-friendly interface

### ⛓️ Storage Options
- **On-Chain Storage**: Permanent blockchain storage using base64 encoding
  - Size limit: 50KB (with automatic compression)
  - Cost: Calculated in CAW tokens based on file size
  - Permanent and censorship-resistant
  - Tagged with "On-chain" badge in UI

- **Off-Chain Storage**: Traditional cloud storage (Future: AWS S3 integration)
  - Size limit: 10MB
  - Cost: Free
  - Fast loading and efficient

### 🔧 Technical Implementation

#### Frontend Components

1. **ImageUpload Component** (`src/components/ImageUpload.tsx`)
   - Handles file selection, validation, and preview
   - Provides storage option selection with cost calculations
   - Automatic compression for on-chain uploads

2. **Image Utilities** (`src/utils/imageUtils.ts`)
   - File validation and format checking
   - Image compression and resizing
   - Base64 conversion for on-chain storage
   - Cost calculation algorithms

3. **PostForm Integration** (`src/components/PostForm.tsx`)
   - Integrated image upload for both mobile and desktop
   - Handles image data in post submission
   - Support for both action types: 'caw' (off-chain) and 'other' (on-chain)

#### Backend Processing

1. **ActionProcessor** (`src/services/ActionProcessor/`)
   - **actionHandlers.ts**: New `handleOtherAction` for image processing
   - **domainProcessor.ts**: Routes OTHER actions to image handler
   - Extracts image data from base64 format
   - Creates caw records with image metadata

2. **Database Schema** (Requires migration)
   ```sql
   ALTER TABLE "Caw" ADD COLUMN "imageData" TEXT;
   ALTER TABLE "Caw" ADD COLUMN "hasImage" BOOLEAN DEFAULT FALSE;
   ```

3. **Action Types**
   - Regular posts: `actionType: 'caw'`
   - Posts with on-chain images: `actionType: 'other'`
   - Text format: `image64:${base64Data}\n\n${textContent}`

#### Display Components

1. **FeedItem Enhancement** (`src/components/FeedItem.tsx`)
   - Displays images with proper aspect ratios
   - Supports both on-chain (base64) and off-chain (URL) images
   - Click handling for future modal implementation
   - "On-chain" badge for blockchain-stored images

2. **Type Definitions** (`src/types.ts`)
   ```typescript
   export type CawItem = {
     // ... existing fields
     imageData?: string // Base64 image data for on-chain images
     imageUrl?: string  // URL for off-chain images
     hasImage?: boolean // Quick check if caw has any image
   }
   ```

## Usage Guide

### For Users
1. Click the image icon in the post composer
2. Drag & drop or select an image file
3. Choose storage option:
   - **Standard Storage**: Free, fast cloud storage
   - **On-Chain Storage**: Permanent blockchain storage (costs CAW tokens)
4. If on-chain and image is too large, automatic compression options are provided
5. Post normally - image will be included with your caw

### For Developers

#### Adding Image Upload to Components
```tsx
import ImageUpload, { StorageType } from '~/components/ImageUpload'
import type { ImageFile } from '~/utils/imageUtils'

const [selectedImage, setSelectedImage] = useState<ImageFile | null>(null)
const [storageType, setStorageType] = useState<StorageType>('off-chain')

const handleImageSelected = (image: ImageFile, storageType: StorageType) => {
  setSelectedImage(image)
  setStorageType(storageType)
}

return (
  <ImageUpload
    onImageSelected={handleImageSelected}
    onImageRemoved={() => setSelectedImage(null)}
  />
)
```

#### Processing Image Data in Actions
```typescript
// For on-chain images
const params: ActionParams = {
  actionType: 'other',
  senderId: activeTokenId!,
  text: `image64:${base64Data}\n\n${textContent}`,
  // ... other params
}
```

## Cost Structure

### On-Chain Storage Pricing
- Base rate: 10 CAW tokens per KB
- Calculated in real-time during upload
- Examples:
  - 10KB image = ~100 CAW tokens
  - 50KB image (max) = ~500 CAW tokens

### Size Optimization
The system automatically compresses images for on-chain storage:
- Original quality reduction: 90% → 70% → 50% → 30%
- Dimension reduction: 1200px → 800px → 600px max width/height
- Format optimization: PNG → JPEG for better compression

## Future Enhancements

### Phase 2: AWS S3 Integration
- Seamless off-chain storage with CDN
- Image optimization and multiple format serving
- Automatic backup and redundancy

### Phase 3: Advanced Features
- **Image Moderation**: Content filtering for inappropriate images
- **NFT Integration**: Convert on-chain images to NFTs
- **Image Galleries**: User image collections and albums
- **Advanced Editing**: Built-in image cropping and filters

### Phase 4: Background Processing
- **Async Image Processing**: Background jobs for compression and optimization
- **Image Analysis**: Automatic alt-text generation and content recognition
- **Batch Operations**: Bulk image processing and migration tools

## Security Considerations

1. **File Validation**: Strict format and size checking
2. **Content Sanitization**: Base64 validation and malicious content detection
3. **Rate Limiting**: Upload frequency limits to prevent spam
4. **Cost Protection**: Clear pricing display before on-chain uploads
5. **Error Handling**: Graceful fallbacks for failed uploads

## API Endpoints

### Image Processing (Future)
- `POST /api/images/upload` - Off-chain image upload
- `POST /api/images/process` - Image compression and optimization
- `GET /api/images/:id` - Retrieve processed images

### Current Integration
Images are processed through existing action endpoints:
- `POST /api/actions` - Handles both regular caws and image actions
- Action types: `caw` (text only) and `other` (with images)

## Database Considerations

### Storage Requirements
- **On-chain images**: Stored as TEXT in database (base64)
- **Off-chain images**: Store URLs/file paths only
- **Metadata**: Image dimensions, format, compression settings

### Performance Optimization
- Index `hasImage` field for efficient querying
- Consider separate table for image metadata if volume grows
- Implement caching for frequently accessed images

## Troubleshooting

### Common Issues
1. **Large file uploads**: Check compression settings and size limits
2. **On-chain costs**: Verify CAW token balance before upload
3. **Mobile compatibility**: Ensure touch events work properly
4. **Browser support**: Verify canvas and FileReader API availability

### Error Messages
- "File too large": Exceed 10MB limit for off-chain or compression failed for on-chain
- "Unsupported format": File type not in allowed list
- "Insufficient funds": Not enough CAW tokens for on-chain storage
- "Upload failed": Network or processing error

## Testing

### Manual Testing Checklist
- [ ] Upload various image formats (PNG, JPG, GIF, WebP)
- [ ] Test size limits (both on-chain 50KB and off-chain 10MB)
- [ ] Verify cost calculations for on-chain uploads
- [ ] Test compression for oversized on-chain images
- [ ] Mobile drag & drop functionality
- [ ] Image display in feed with proper aspect ratios
- [ ] On-chain badge display for blockchain-stored images

### Automated Testing
- Unit tests for image utilities (compression, validation)
- Integration tests for upload workflow
- E2E tests for complete user journey
- Performance tests for large image processing

---

*This system provides a solid foundation for image functionality in CAW Protocol while maintaining the decentralized ethos with optional on-chain storage.*