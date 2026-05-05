import { useState, useEffect } from 'react'

export function useOrientation() {
  const [isPortrait, setIsPortrait] = useState(
    window.matchMedia('(orientation: portrait)').matches
  )
  const [isLandscape, setIsLandscape] = useState(
    window.matchMedia('(orientation: landscape)').matches
  )

  useEffect(() => {
    const portraitMediaQuery = window.matchMedia('(orientation: portrait)')
    const landscapeMediaQuery = window.matchMedia('(orientation: landscape)')

    const handleOrientationChange = () => {
      setIsPortrait(portraitMediaQuery.matches)
      setIsLandscape(landscapeMediaQuery.matches)
    }

    portraitMediaQuery.addEventListener('change', handleOrientationChange)
    landscapeMediaQuery.addEventListener('change', handleOrientationChange)

    return () => {
      portraitMediaQuery.removeEventListener('change', handleOrientationChange)
      landscapeMediaQuery.removeEventListener('change', handleOrientationChange)
    }
  }, [])

  return { isPortrait, isLandscape }
}
