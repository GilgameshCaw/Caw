# OTHER Action Type Documentation

The `OTHER` action type in the CAW protocol is used for various custom operations that don't fit into the standard action types (POST, LIKE, FOLLOW, etc.). This document describes all current uses of the OTHER action type.

## Profile Updates

Profile updates allow users to modify their profile information on-chain.

### Format
```
p:{JSON_DATA}
```

### Compact Key Mapping
To minimize gas costs, profile updates use single-character keys:
- `d` → `bio` (description/bio text)
- `l` → `location`
- `w` → `website`
- `a` → `avatarUrl`
- `c` → `coverPhotoUrl`

### Example
```json
// Action text:
p:{"d":"Web3 developer","l":"San Francisco","w":"example.com"}

// This updates:
// - bio to "Web3 developer"
// - location to "San Francisco"
// - website to "example.com"
```

### Cost Calculation
- Base cost: 100 CAW
- Additional: 10 CAW per character in the JSON string
- Formula: `100 + (length_of_data * 10)`

### Legacy Format (still supported)
```
profile-update:{JSON_DATA}
```
Uses full field names: `bio`, `location`, `website`, `avatarUrl`, `coverPhotoUrl`

## Image Uploads

Images can be stored on-chain using the OTHER action type.

### Format
```
image64:[BASE64_DATA]
[OPTIONAL_TEXT_CONTENT]
```

### Multiple Images
Multiple images are separated by newlines:
```
image64:[BASE64_DATA_1]
image64:[BASE64_DATA_2]
[OPTIONAL_TEXT_CONTENT]
```

### Example
```
image64:iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==
Check out this image!
```

## Video References

Videos are stored off-chain but referenced on-chain.

### Format
```
video:[VIDEO_URL_1]|||[VIDEO_URL_2]
[OPTIONAL_TEXT_CONTENT]
```

### Example
```
video:https://example.com/video1.mp4|||https://example.com/video2.mp4
Check out these videos!
```

## Processing Logic

The server-side handler (`actionHandlers.ts`) processes OTHER actions in this order:

1. **Check for profile update** (`p:` or `profile-update:`)
   - Parse JSON data
   - Validate and sanitize fields
   - Update user record in database
   - Exit early if successful

2. **Check for image data** (`image64:`)
   - Extract base64 image data
   - Store in database as image data
   - Continue processing remaining text

3. **Check for video URLs** (`video:`)
   - Extract video URLs
   - Store in database as video data
   - Continue processing remaining text

4. **Process as regular post**
   - Any remaining text becomes post content
   - Create CAW record with attached media

## Field Validation

### Profile Fields
- `bio`: Max 500 characters
- `displayName`: Max 50 characters
- `location`: Max 100 characters
- `website`: Max 200 characters, basic URL validation
- `avatarUrl`: Max 500 characters
- `coverPhotoUrl`: Max 500 characters

### Media
- Images: Stored as base64 strings
- Videos: URLs only, actual files stored off-chain

## Tips for Developers

1. **Use compact format** for profile updates to save gas
2. **Batch updates** when possible - update multiple fields in one transaction
3. **Validate URLs** client-side before submission
4. **Compress images** before base64 encoding to reduce size
5. **Consider off-chain storage** for large media files

## Future Considerations

The OTHER action type is extensible. New formats can be added by:
1. Defining a unique prefix (keep it short for gas efficiency)
2. Adding handler logic in `actionHandlers.ts`
3. Documenting the format here

Potential future uses:
- `s:` - Settings/preferences updates
- `b:` - Badge/achievement claims
- `m:` - Metadata updates
- `t:` - Theme customizations