# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CAW Protocol is a trustless and decentralized social clearing-house focused on freedom of speech. The project consists of smart contracts, backend services, and a React frontend.

## Repository Structure

- `solidity/` - Smart contracts for mainnet and L2 deployment
- `client/` - Backend services and infrastructure
- `client/src/services/FrontEnd/` - React frontend application
- `UI_CONSISTENCY_STANDARD.md` - UI guidelines for post display consistency

## Development Commands

### Root Level
- `npm start` - Start Redis and API services concurrently
- `npm run dev` - Start Redis, API (with hot reload), and web frontend
- `npm run api` - Start the API server only
- `npm run web` - Start the frontend dev server only
- `npm run redis` - Start Redis server on port 6379
- `npm test` - Run TypeScript compilation check and Mocha tests

### Frontend (client/src/services/FrontEnd/)
- `yarn dev` or `npm run dev` - Start Vite dev server on localhost
- `yarn build` or `npm run build` - TypeScript compile and build for production
- `yarn lint` or `npm run lint` - Run ESLint
- `yarn preview` or `npm run preview` - Preview production build

### Smart Contracts (solidity/)
Uses Truffle for deployment and testing. Networks configured include:
- `dev`/`devL1` - Local development (port 8545)
- `devL2` - Local L2 development (port 8546)
- `testnetL1` - Sepolia testnet
- `testnetL2` - Base Sepolia testnet

## Architecture

### Smart Contracts
- **CawActions.sol** - Core contract for CAW social actions (post, like, follow, etc.)
- **CawName.sol** / **CawNameL2.sol** - Name service contracts for L1/L2
- **CawClientManager.sol** - Client management system
- Uses LayerZero for cross-chain functionality
- EIP712 signing for action verification

### Backend Services (client/src/services/)
- **ActionProcessor** - Processes and indexes blockchain events
- **Api** - REST API server
- **FrontEnd** - React application
- **RawEventsGatherer** - Reads CAW events from blockchain
- **ValidatorService** - Validates new actions on chain
- **UserService** - User management functionality

### Frontend Tech Stack
- **React 18** with TypeScript
- **Vite** for build tooling
- **TailwindCSS** for styling (v4)
- **React Router v7** for navigation
- **Wagmi + RainbowKit** for Web3 integration
- **Zustand** for state management
- **React Query** for server state
- **Framer Motion** for animations

### Database & Infrastructure
- **PostgreSQL** with Prisma ORM
- **Redis** for caching
- **TypeORM** for additional database operations

## UI Standards

Follow the container standard defined in `UI_CONSISTENCY_STANDARD.md`:
- All pages displaying posts must use `<div className="max-w-2xl mx-auto px-6 py-4">`
- Consistent mock usernames across the application
- Use `Feed` and `FeedItem` components for post display

## Key Development Notes

- The project uses a monorepo structure with separate package.json files for different components
- Smart contracts support both L1 (Ethereum) and L2 (Base) deployments
- Frontend uses path aliases configured in `vite.config.ts` (~ prefix)
- TypeScript strict mode enabled across all components
- ESLint configured with React-specific rules