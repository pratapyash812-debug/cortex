"""Build a verified lean release without copying the development environment.
Run npm ci and npm run build in web first. See stage_release.py for the offline manifest.
"""
from pathlib import Path
import argparse
from stage_release import stage
if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--runtime',type=Path,required=True,help='Existing signed Python runtime folder')
    p.add_argument('--destination',type=Path,required=True,help='New release output folder')
    args=p.parse_args();stage(args.destination,args.runtime)
