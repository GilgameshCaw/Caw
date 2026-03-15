// contracts/CawNameURI.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
import "@openzeppelin/contracts/utils/Base64.sol";


contract CawNameURI is Ownable {

  string public description = "CAW NAMEs are username NFTs the CAW social network on the ethereum chain.";

  function _hasDescender(string memory name) internal pure returns (bool) {
    bytes memory b = bytes(name);
    for (uint i = 0; i < b.length; i++) {
      bytes1 c = b[i];
      if (c == 'j' || c == 'f' || c == 'y' || c == 'g' || c == 'p' || c == 'q') return true;
    }
    return false;
  }

  function _endsWithTallChar(string memory name) internal pure returns (bool) {
    bytes memory b = bytes(name);
    bytes1 last = b[b.length - 1];
    return (last == 'd' || last == 'f' || last == 'l');
  }

  function generate(string memory name) public view returns (string memory) {
    string[5] memory parts;
    uint8 length = uint8(bytes(name).length);

    // Font sizes that look nice with different character lengths.
    // anything over 17 will just be cut off. These were hand chosen:
    uint8 fontSize = 22;
    if (length == 16)
      fontSize = 23;
    else if (length == 15)
      fontSize = 25;
    else if (length == 14)
      fontSize = 27;
    else if (length == 13)
      fontSize = 29;
    else if (length == 12)
      fontSize = 31;
    else if (length == 11)
      fontSize = 33;
    else if (length == 10)
      fontSize = 36;
    else if (length == 9)
      fontSize = 40;
    else if (length == 8)
      fontSize = 44;
    else if (length == 7)
      fontSize = 49;
    else if (length == 6)
      fontSize = 55;
    else if (length == 5)
      fontSize = 64;
    else if (length == 4)
      fontSize = 77; // xposition needs to be 89%
    else if (length == 3)
      fontSize = 99;
    else if (length == 2)
      fontSize = 133; // xposition needs to be 88%
    else if (length == 1)
      fontSize = 176;

    // Narrow characters (i,j,f,l,t) get +3px fontSize each (skip if >10 narrow chars)
    {
      uint8 narrowCount = 0;
      bytes memory b = bytes(name);
      for (uint i = 0; i < b.length; i++) {
        bytes1 c = b[i];
        if (c == 'i' || c == 'j' || c == 'f' || c == 'l' || c == 't') {
          narrowCount++;
        }
      }
      if (narrowCount <= 10) {
        fontSize += narrowCount * 3;
      }
    }

    // Y position: adjust for descender characters (j,f,y,g,p,q) at short lengths
    string memory yposition = '231';
    if (_hasDescender(name)) {
      if (length == 1) yposition = '180';
      else if (length == 2) yposition = '200';
      else if (length == 3) yposition = '210';
      else if (length <= 5) yposition = '220';
    }

    // X position: adjust for trailing tall characters (d,f,l) at short lengths
    string memory xposition = '90';
    if (_endsWithTallChar(name)) {
      if (length == 1) xposition = '75';
      else if (length == 2) xposition = '80';
      else if (length <= 4) xposition = '89';
    } else {
      if (length <= 2) xposition = '88';
      else if (length <= 4) xposition = '89';
    }

    parts[0] = '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 270 270" fill="none"> <defs><clipPath id="roundedClip"><rect width="270" height="270" rx="22" ry="22"/></clipPath></defs> <g clip-path="url(#roundedClip)"><rect width="270" height="270" fill="url(#paint0_linear)"/>';

    //Logo:
    parts[1] = '<path d="M30.36,35.15l15.28,1.29a7.47,7.47,0,0,0,5.29-3l-1.84-7.27a33,33,0,0,1,8.77,0L56,33.42s1.69,3.13,6.6,2.94c.75,0,14-1.25,14-1.25L69.15,45.52l-5.73.54a9.57,9.57,0,0,1-4.11-.29,10.59,10.59,0,0,1-3-1.63L53.47,50.6l-2.73-6.45a10.13,10.13,0,0,0-1.52.88c-2,1.36-5.49,1.08-5.49,1.08l-5.82-.48Z" style="fill:#000000"/><path d="M48.32,84.39,41.8,70.51a7.45,7.45,0,0,0-5.25-3.07l-5.39,5.22a33.26,33.26,0,0,1-4.4-7.58L34,63s1.86-3-.75-7.18c-.4-.63-8.06-11.48-8.06-11.48l12.72,1.23,3.33,4.69A9.54,9.54,0,0,1,43.05,54a10.71,10.71,0,0,1,.09,3.41l7-.76-4.22,5.59a10.44,10.44,0,0,0,1.52.86c2.19,1.08,3.67,4.22,3.67,4.22l2.5,5.28Z" style="fill:#000000"/><path d="M82,44.21,73.25,56.8a7.46,7.46,0,0,0,0,6.09l7.22,2a32.65,32.65,0,0,1-4.36,7.6l-5.39-5.26s-3.55-.1-5.85,4.25c-.35.66-5.9,12.72-5.9,12.72l-5.3-11.64L56,67.39A9.69,9.69,0,0,1,58.34,64a10.82,10.82,0,0,1,2.9-1.78L57.07,56.5l6.95.86a11.11,11.11,0,0,0,0-1.76c-.17-2.43,1.81-5.29,1.81-5.29l3.32-4.8Z" style="fill:#000000"/><text y="';

    parts[2] = '" font-size="';

    parts[3] = string(abi.encodePacked('px" fill="rgb(235,192,70)" font-family="cursive" font-weight="bold" style="text-anchor: end;" x="', xposition, '%">'));

    parts[4] = '</text></g> <rect x="0.5" y="0.5" width="269" height="269" rx="22" ry="22" fill="none" stroke="rgba(240,177,0,0.3)" stroke-width="1"/> <defs> <linearGradient id="paint0_linear" x1="110.5" y1="140" x2="8" gradientUnits="userSpaceOnUse" y42="37.5"> <stop stop-color="#000000"/> <stop offset="0.35" stop-color="#ECc052"/> <stop offset="1" stop-color="#ECc052"/> </linearGradient> </defs> </svg>';

    string memory output = string(abi.encodePacked(parts[0], parts[1], yposition, parts[2], Strings.toString(fontSize), parts[3], name, parts[4]));

    string memory json = Base64.encode(bytes(string(abi.encodePacked('{"name": "', name, '", "description": "', description, '", "image": "data:image/svg+xml;base64,', Base64.encode(bytes(output)), '"}'))));
    output = string(abi.encodePacked('data:application/json;base64,', json));

    return output;
  }

  function setDescription(string memory _description) public onlyOwner {
    description = _description;
  }
}
