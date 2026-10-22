"""Emit standalone compiler input; run from any directory."""
from pathlib import Path
import json
source=Path(__file__).resolve().parent.parent/'contracts/CawNetworkManager.sol'
print(json.dumps({'language':'Solidity','sources':{'contracts/CawNetworkManager.sol':{'content':source.read_text(encoding='utf-8')}},'settings':{'optimizer':{'enabled':True,'runs':200},'viaIR':True,'evmVersion':'prague','outputSelection':{'*':{'*':['abi','evm.bytecode.object','evm.deployedBytecode.object']}}}}))
