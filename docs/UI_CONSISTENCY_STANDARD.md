# UI Consistency Standard - Post Display

## Overview
This document establishes the standard for displaying posts across all pages in the Caw Protocol application to ensure visual consistency.

## Container Standard
All pages that display posts (using `Feed` or `FeedItem` components) MUST use the following container structure:

```tsx
<div className="max-w-2xl mx-auto px-6 py-4">
  {/* Page content including posts */}
</div>
```

## Applied Pages
The following pages have been updated to follow this standard:

### ✅ Completed
- **Main Page** (`/pages/Main/Main.tsx`) - Home feed (Following/For You tabs)
- **Profile Page** (`/pages/Profile/Profile.tsx`) - User profile posts
- **CawPage** (`/pages/CawPage.tsx`) - Individual post view and comments
- **Explore Page** (`/pages/Explore.tsx`) - Already had correct container
- **Bookmarks Page** (`/pages/Bookmarks.tsx`) - Reference implementation

## Container Classes Explained
- `max-w-2xl`: Limits maximum width to 672px (42rem)
- `mx-auto`: Centers the container horizontally
- `px-6`: Adds 24px horizontal padding
- `py-4`: Adds 16px vertical padding

## Why This Standard?
1. **Consistency**: All posts look identical across the application
2. **Readability**: Optimal width for reading social media content
3. **Responsive**: Works well on all screen sizes
4. **Future-proof**: When real database is connected, all posts will maintain this layout

## Implementation for New Pages
When creating new pages that display posts:

1. Wrap the entire page content in the standard container
2. Place `Feed` or `FeedItem` components inside this container
3. Ensure the container is the direct child of `MainLayout`

### Example Template
```tsx
import MainLayout from '~/layouts/MainLayout'
import Feed from '~/components/Feed'

export const NewPage: React.FC = () => {
  return (
    <MainLayout>
      <div className="max-w-2xl mx-auto px-6 py-4">
        {/* Page header */}
        <h1>Page Title</h1>
        
        {/* Posts feed */}
        <Feed filter="your-filter" />
      </div>
    </MainLayout>
  )
}
```

## Mock Data Consistency
All mock data across the application uses the same usernames and content structure to ensure visual consistency:

- `cawuser1` - 👤
- `blockchaindev` - 👨‍💻  
- `cryptoenthusiast` - 🚀
- `web3builder` - 🔧
- `cawcommunity` - 👥
- `decentralized` - 🌐

## Last Updated
September 4, 2025 - Initial implementation and documentation
